const MAX_MANIFEST_SIZE = 10485760 // 10 MiB

declare global {
  const TAGS: KVNamespace
  const MANIFESTS: KVNamespace
  const BUCKET: R2Bucket
}

// TODO(jason): This is gross. Use a real thing for routing.
const manifestRE = /\/v2\/([0-9a-z-\/]+)\/manifests\/([0-9a-z-:]+)/g
const blobRE = /\/v2\/([0-9a-z-\/]+)\/blobs\/(sha256:[0-9a-z]+)/g
const uploadRE = /\/v2\/([0-9a-z-\/]+)\/blobs\/uploads\/([0-9a-z-]+)?/g
const tagsListRE = /\/v2\/([0-9a-z-\/]+)\/tags\/list/g

export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname == '/v2/') {
    return new Response('')
  }
  if (url.pathname == '/favicon.ico') {
    return new Response('')
  }

  if (request.method == "GET" || request.method == "HEAD") {
    return get(request)
  }
  if (request.method == "PUT" || request.method == "POST" || request.method == "PATCH") {
    return put(request)
  }
  if (request.method == "DELETE") {
    return _delete(request)
  }

  return new Response('Not found', { status: 404 })
}

async function put(request: Request): Promise<Response> {
  const url = new URL(request.url)

  // Try to match manifests.
  let found = [...url.pathname.matchAll(manifestRE)]
  if (found.length > 0) {
    const parts = [...Array(found)[0]][0]
    if (parts.length >= 3) {
      const repo = parts[1]
      const tagOrDigest = parts[2]

      const mediaType: string | null = request.headers.get("Content-Type")
      if (mediaType == undefined) {
        return manifestInvalid("Content-Type is required")
      }
      const size: number = +(request.headers.get("Content-Length") || 0)
      if (size == 0) {
        return manifestInvalid("Content-Length is required")
      }
      if (size > MAX_MANIFEST_SIZE) {
        return manifestTooLarge()
      }

      const body = await request.text()

      if (tagOrDigest.startsWith('sha256:')) {
        const digest = tagOrDigest
        console.log(`${request.method} repo: ${repo} / digest: ${digest}`)
        return postManifest(repo, mediaType, digest, body)
      } else if (tagOrDigest.includes(':')) {
        return nameInvalid()
      } else {
        const tag = tagOrDigest
        console.log(`${request.method} repo: ${repo} / tag: ${tag}`)
        return postTag(repo, mediaType, tag, body)
      }
    }
  }

  // Try to match uploads.
  found = [...url.pathname.matchAll(uploadRE)]
  if (found.length > 0) {
    const parts = [...Array(found)[0]][0]
    if (parts.length >= 3) {
      const repo = parts[1]
      const uploadID = parts[2]

      if (uploadID == undefined) {
        const uploadID = crypto.randomUUID()
        console.log(`Creating new upload: ${uploadID}`)
        return new Response('', {
          status: 202,
          headers: {
            'Location': url.toString() + uploadID,
            'Range': '0-0',
          }
        })
      } else {
        // TODO: This buffers the whole upload into memory.
        //       Instead, we could redirect uploads to a signed, expiring, write-only URL,
        //       and only read this chunk when checking the digest when the upload is complete.
        // TODO: Getting a non-existent blob may throw an exception for now.
        let sofar = new ArrayBuffer(0)
        try {
          let obj = await BUCKET.get(`${repo}%%${uploadID}`)
          if (obj != null) {
            sofar = await obj.arrayBuffer()
          }
        } catch {
          // Upload wasn't found, leave sofar empty.
        }
        // TODO: Enforce max upload chunk size here.
        let body = await (await request.blob()).arrayBuffer()

        // TODO: Get request's Content-Range and check that it matches current size.

        // Concatenate what we have so far with the new incoming chunk.
        // TODO: Enforce max blob size here.
        var tmp = new Uint8Array(sofar.byteLength + body.byteLength);
        tmp.set(new Uint8Array(sofar), 0);
        tmp.set(new Uint8Array(body), sofar?.byteLength);
        let total = tmp.buffer

        // On PUT, check digest and finalize blob; cleanup upload.
        if (request.method == "PUT") {
          const digest = url.searchParams.get('digest')
          const gotDigest = await getDigestBuf(total)
          if (gotDigest != digest) {
            console.log(`digest mismatch: ${gotDigest} != ${digest}`)
            return digestInvalid()
          }
          // TODO: This will result in duplicate storage for the same blob in two repos.
          //       Instead, we could only store blobs by digest, and keep track of which repos
          //       have those blobs@digest; this would also help us when mounting layers.
          await BUCKET.put(`${repo}@${digest}`, total)
          await BUCKET.delete(`${repo}%%${uploadID}`)

          // Redirect to the finalized blob.
          return new Response('Created', {
            status: 201,
            headers: {
              'Location': `${url.protocol}//${url.host}/v2/${repo}/blobs/${digest}`,
              'Range': `0-${total.byteLength - 1}`,
            }
          })
        } else {
          // Otherwise, just put back the appended upload.
          await BUCKET.put(`${repo}%%${uploadID}`, total)
          return new Response('Accepted', {
            status: 201,
            headers: {
              'Location': url.toString(),
              'Range': `0-${total.byteLength - 1}`,
            }
          })
        }
      }
    }

    return new Response('Not found', { status: 404 })
  }

  // Try to match blobs.
  found = [...url.pathname.matchAll(blobRE)]
  if (found.length > 0) {
    const parts = [...Array(found)[0]][0]
    if (parts.length >= 3) {
      const repo = parts[1]
      const digest = parts[2]
      await BUCKET.put(`${repo}@${digest}`, request.body)
      return new Response('') // OK
    }
  }

  return new Response('Not found', { status: 404 })
}

interface ImageManifest {
  schemaVersion: number;
  mediaType: string;
  config: Descriptor;
  layers: Array<Descriptor>;
}

interface IndexManifest {
  schemaVersion: number;
  mediaType: string;
  manifests: Array<Descriptor>;
}

interface Descriptor {
  digest: string;
  size: number;
  mediaType: string;
  annotations: Map<string, string>;
}

const OCIManifestSchema1: string = "application/vnd.oci.image.manifest.v1+json"
const DockerManifestSchema2: string = "application/vnd.docker.distribution.manifest.v2+json"
const DockerManifestList: string = "application/vnd.docker.distribution.manifest.list.v2+json"
const OCIImageIndex: string = "application/vnd.oci.image.index.v1+json"

async function validateManifest(repo: string, mediaType: string, body: string): Promise<Response | null> {
  switch (mediaType) {
    case OCIManifestSchema1:
    case DockerManifestSchema2:
      const imageManifest: ImageManifest = JSON.parse(body)
      if (imageManifest.schemaVersion != 2) {
        return manifestInvalid(`unsupported schemaVersion ${imageManifest.schemaVersion}`)
      }
      if (mediaType != imageManifest.mediaType) {
        return manifestInvalid(`mediaType mismatch; ${mediaType} vs ${imageManifest.mediaType}`)
      }

      // Check that every referenced blob already exists.
      // TODO: Getting a non-existent blob may throw an exception for now.
      try {
        await BUCKET.get(`${repo}@${imageManifest.config.digest}`)
      } catch {
        return manifestBlobUnknown(imageManifest.config.digest)
      }

      imageManifest.layers.forEach(async (l) => {
        // TODO: Getting a non-existent blob may throw an exception for now.
        try {
          await BUCKET.get(l.digest)
        } catch {
          return manifestBlobUnknown(l.digest)
        }
      })
      return null

    case OCIImageIndex:
    case DockerManifestList:
      const indexManifest: IndexManifest = JSON.parse(body)
      if (indexManifest.schemaVersion != 2) {
        return manifestInvalid(`unsupported schemaVersion ${indexManifest.schemaVersion}`)
      }
      if (mediaType != indexManifest.mediaType) {
        return manifestInvalid(`mediaType mismatch; ${mediaType} vs ${indexManifest.mediaType}`)
      }
      // NB: Not checking that referenced manifests exist, or that their blobs exist.
      // https://groups.google.com/a/opencontainers.org/g/dev/c/Uw8xdBOr444?pli=1
      return null
  }

  return manifestInvalid(`unsupported media type: ${mediaType}`)
}


async function postManifest(repo: string, mediaType: string, digest: string, body: string): Promise<Response> {
  const gotDigest = await getDigest(body)
  if (gotDigest != digest) {
    console.log(`digest mismatch: ${gotDigest} != ${digest}`)
    return digestInvalid()
  }

  const resp = await validateManifest(repo, mediaType, body)
  if (resp != null) { return resp }

  await MANIFESTS.put(`${repo}@${digest}`, body)
  return new Response('', {
    status: 201, // Created
    headers: {
      'Docker-Content-Digest': digest,
    },
  })
}

async function postTag(repo: string, mediaType: string, tag: string, body: string): Promise<Response> {
  const resp = await validateManifest(repo, mediaType, body)
  if (resp != null) { return resp }

  const digest = await getDigest(body)
  await MANIFESTS.put(`${repo}@${digest}`, body)
  await TAGS.put(`${repo}:${tag}`, digest)
  return new Response('', {
    status: 201, // Created
    headers: {
      'Docker-Content-Digest': digest,
    },
  })
}

async function get(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const head = request.method == "HEAD"

  // Try to match manifests.
  let found = [...url.pathname.matchAll(manifestRE)]
  if (found.length > 0) {
    const parts = [...Array(found)[0]][0]
    if (parts.length >= 3) {
      const repo = parts[1]
      const tagOrDigest = parts[2]
      if (tagOrDigest.startsWith('sha256:')) {
        const digest = tagOrDigest
        console.log(`${request.method} repo: ${repo} / digest: ${digest}`)
        return getManifest(head, repo, digest)
      } else if (!tagOrDigest.includes(':')) {
        const tag = tagOrDigest
        console.log(`${request.method} repo: ${repo} / tag: ${tag}`)
        return getTag(head, repo, tag)
      }
    }
  }

  // Try to match blobs.
  found = [...url.pathname.matchAll(blobRE)]
  if (found.length > 0) {
    const parts = [...Array(found)[0]][0]
    if (parts.length >= 3) {
      const repo = parts[1]
      const digest = parts[2]
      console.log(`${request.method} BLOB repo: ${repo} / digest ${digest}`)
      return getBlob(head, repo, digest)
    }
  }

  // Try to match tags list.
  found = [...url.pathname.matchAll(tagsListRE)]
  if (found.length > 0) {
    const parts = [...Array(found)[0]][0]
    if (parts.length >= 2) {
      const repo = parts[1]
      const count = +(url.searchParams.get('n') || 100) // Default tag page size
      const last = url.searchParams.get('last')
      console.log(`${request.method} LIST repo: ${repo}`)
      return listTags(repo, count, last)
    }
  }

  return new Response('Not found', { status: 404 })
}

async function getTag(head: boolean, repo: string, tag: string): Promise<Response> {
  const digest = await TAGS.get(`${repo}:${tag}`)
  if (digest === null) {
    console.log(`${repo}:${tag} not found`)
    return manifestUnknown()
  }
  console.log(`${repo}:${tag} -> ${digest}`)
  return getManifest(head, repo, digest)
}

async function getDigest(content: string): Promise<string> {
  const uint8arr = new Uint8Array(await crypto.subtle.digest({ name: 'SHA-256' }, new TextEncoder().encode(content)))
  return "sha256:" + hex(uint8arr)
}

async function getDigestBuf(content: ArrayBuffer): Promise<string> {
  const uint8arr = new Uint8Array(await crypto.subtle.digest({ name: 'SHA-256' }, content))
  return "sha256:" + hex(uint8arr)
}

async function listTags(repo: string, count: number, last: string | null): Promise<Response> {
  const resp = await TAGS.list({
    prefix: `${repo}:`,
    // cursor: last, TODO: This isn't how cursor works...
    limit: count,
  })
  if (resp == null) {
    return new Response('Not found', { status: 404 })
  }
  let headers = {}
  let link: string | null = null
  if (!resp.list_complete) {
    const lastKey = resp.keys[resp.keys.length - 1]
    link = `</v2/${repo}/tags/list?n=${count}&last=${lastKey}">; rel=next`
    headers = { 'Link': link }
  }
  return new Response(JSON.stringify({
    name: repo,
    tags: resp.keys.flatMap(function (s: KVNamespaceListKey<unknown>): string {
      return s.name.substring(repo.length + 1)
    })
  }), { headers: headers })
}

// https://stackoverflow.com/a/40031979
function hex(arr: Uint8Array): string {
  return [...arr]
    .map(x => x.toString(16).padStart(2, '0'))
    .join('');
}

async function getManifest(
  head: boolean,
  repo: string,
  digest: string,
): Promise<Response> {
  let manifest = await MANIFESTS.get(`${repo}@${digest}`)
  if (manifest === null) {
    console.log(`${repo}:${digest} not found`)
    return manifestUnknown()
  }

  // Check that manifest matches expected digest.
  const gotDigest = await getDigest(manifest)
  if (gotDigest != digest) {
    console.log(`digest mismatch: ${gotDigest} != ${digest}`)
    return digestInvalid()
  }

  const contentType = JSON.parse(manifest).mediaType
  const size = manifest.length
  if (head) { manifest = '' } // Clear body before responding.
  return new Response(manifest, {
    headers: {
      'Docker-Content-Digest': digest,
      'Content-Type': contentType,
      'Content-Length': `${size}`,
    },
  })
}

async function getBlob(
  head: boolean,
  repo: string,
  digest: string,
): Promise<Response> {
  // TODO: Getting a non-existent blob may throw an exception for now.
  let blob = new ArrayBuffer(0)
  try {
    // TODO: this buffers the whole blob into memory.
    let obj = await BUCKET.get(`${repo}@${digest}`)
    if (obj == null) {
      console.log(`${repo}:${digest} not found`)
      return blobUnknown()
    }
    blob = await obj.arrayBuffer()
  } catch {
    return blobUnknown()
  }

  // TODO: Redirect to signed, expriring, read-only URL for the blob.
  //       This will mean digests are only checked on upload.

  // Check that manifest matches expected digest.
  const gotDigest = await getDigestBuf(blob)
  if (gotDigest != digest) {
    console.log(`digest mismatch: ${gotDigest} != ${digest}`)
    return digestInvalid()
  }
  if (head) { blob = new ArrayBuffer(0) }
  const size = blob.byteLength
  return new Response(blob, {
    headers: {
      'Docker-Content-Digest': digest,
      'Content-Length': `${size}`,
    },
  })
}

async function _delete(request: Request): Promise<Response> {
  const url = new URL(request.url)

  // Try to match manifests.
  let found = [...url.pathname.matchAll(manifestRE)]
  if (found.length > 0) {
    const parts = [...Array(found)[0]][0]
    if (parts.length >= 3) {
      const repo = parts[1]
      const tagOrDigest = parts[2]
      if (tagOrDigest.startsWith('sha256:')) {
        const digest = tagOrDigest
        console.log(`${request.method} repo: ${repo} / digest: ${digest}`)
        return deleteManifest(repo, digest)
      } else if (!tagOrDigest.includes(':')) {
        const tag = tagOrDigest
        console.log(`${request.method} repo: ${repo} / tag: ${tag}`)
        return deleteTag(repo, tag)
      }
    }
  }

  // Try to match blobs.
  found = [...url.pathname.matchAll(blobRE)]
  if (found.length > 0) {
    const parts = [...Array(found)[0]][0]
    if (parts.length >= 3) {
      const repo = parts[1]
      const digest = parts[2]
      console.log(`${request.method} BLOB repo: ${repo} / digest ${digest}`)
      return deleteBlob(repo, digest)
    }
  }

  return new Response('Not found', { status: 404 })
}

async function deleteManifest(
  repo: string,
  digest: string,
): Promise<Response> {
  let manifest = await MANIFESTS.get(`${repo}@${digest}`)
  if (manifest === null) {
    console.log(`${repo}:${digest} not found`)
    return manifestUnknown()
  }
  await MANIFESTS.delete(`${repo}@${digest}`)
  return new Response('Accepted', { status: 202 })
}

async function deleteTag(
  repo: string,
  tag: string,
): Promise<Response> {
  let digest = await TAGS.get(`${repo}:${tag}`)
  if (digest === null) {
    console.log(`${repo}:${tag} not found`)
    return manifestUnknown()
  }
  await TAGS.delete(`${repo}:${tag}`)
  return new Response('Accepted', { status: 202 })
}

async function deleteBlob(
  repo: string,
  digest: string,
): Promise<Response> {
  // TODO: Getting a non-existent blob may throw an exception for now.
  try {
    await BUCKET.delete(`${repo}@${digest}`)
    return new Response('Accepted', { status: 202 })
  } catch {
    return blobUnknown()
  }
}

function manifestUnknown(): Response {
  return new Response(JSON.stringify({
    errors: [{
      code: "MANIFEST_UNKNOWN",
      message: "Manifest not found",
    }]
  }), {
    status: 404,
  })
}

function manifestInvalid(msg: string): Response {
  return new Response(JSON.stringify({
    errors: [{
      code: "MANIFEST_INVALID",
      message: msg
    }]
  }), {
    status: 404,
  })
}

function digestInvalid(): Response {
  return new Response(JSON.stringify({
    errors: [{
      code: "DIGEST_INVALID",
      message: "Digest mismatch",
    }]
  }), {
    status: 400,
  })
}

function nameInvalid(): Response {
  return new Response(JSON.stringify({
    errors: [{
      code: "NAME_INVALID",
      message: "Name is malformed",
    }]
  }), {
    status: 400,
  })
}

function blobUnknown(): Response {
  return new Response(JSON.stringify({
    errors: [{
      code: "BLOB_UNKNOWN",
      message: "Blob not found",
    }]
  }), {
    status: 404,
  })
}

function manifestTooLarge(): Response {
  return new Response(JSON.stringify({
    errors: [{
      code: "MANIFEST_INVALID",
      message: "Manifest too large",
    }]
  }), {
    status: 413,
  })
}

function manifestBlobUnknown(digest: string): Response {
  return new Response(JSON.stringify({
    errors: [{
      code: "MANIFEST_BLOB_UNKNOWN",
      message: `Manifest blob ${digest} unknown`,
    }]
  }), {
    status: 400,
  })
}
