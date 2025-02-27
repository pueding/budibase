require("svelte/register")

const send = require("koa-send")
const { resolve, join } = require("../../../utilities/centralPath")
const uuid = require("uuid")
const { ObjectStoreBuckets } = require("../../../constants")
const { processString } = require("@budibase/string-templates")
const {
  loadHandlebarsFile,
  NODE_MODULES_PATH,
  TOP_LEVEL_PATH,
} = require("../../../utilities/fileSystem")
const env = require("../../../environment")
const { clientLibraryPath } = require("../../../utilities")
const { upload } = require("../../../utilities/fileSystem")
const { attachmentsRelativeURL } = require("../../../utilities")
const { DocumentTypes, isDevAppID } = require("../../../db/utils")
const { getAppDB, getAppId } = require("@budibase/backend-core/context")
const { setCookie, clearCookie } = require("@budibase/backend-core/utils")
const AWS = require("aws-sdk")
const { events } = require("@budibase/backend-core")

const fs = require("fs")
const {
  downloadTarballDirect,
} = require("../../../utilities/fileSystem/utilities")

async function prepareUpload({ s3Key, bucket, metadata, file }) {
  const response = await upload({
    bucket,
    metadata,
    filename: s3Key,
    path: file.path,
    type: file.type,
  })

  // don't store a URL, work this out on the way out as the URL could change
  return {
    size: file.size,
    name: file.name,
    url: attachmentsRelativeURL(response.Key),
    extension: [...file.name.split(".")].pop(),
    key: response.Key,
  }
}

exports.toggleBetaUiFeature = async function (ctx) {
  const cookieName = `beta:${ctx.params.feature}`

  if (ctx.cookies.get(cookieName)) {
    clearCookie(ctx, cookieName)
    ctx.body = {
      message: `${ctx.params.feature} disabled`,
    }
    return
  }

  let builderPath = resolve(TOP_LEVEL_PATH, "new_design_ui")

  // // download it from S3
  if (!fs.existsSync(builderPath)) {
    fs.mkdirSync(builderPath)
  }
  await downloadTarballDirect(
    "https://cdn.budi.live/beta:design_ui/new_ui.tar.gz",
    builderPath
  )
  setCookie(ctx, {}, cookieName)

  ctx.body = {
    message: `${ctx.params.feature} enabled`,
  }
}

exports.serveBuilder = async function (ctx) {
  // Temporary: New Design UI
  const designUiCookie = ctx.cookies.get("beta:design_ui")
  // TODO: get this from the tmp Dir that we downloaded from MinIO
  const uiPath = designUiCookie ? "new_design_ui" : "builder"

  let builderPath = resolve(TOP_LEVEL_PATH, uiPath)
  await send(ctx, ctx.file, { root: builderPath })
  if (!ctx.file.includes("assets/")) {
    await events.serve.servedBuilder()
  }
}

exports.uploadFile = async function (ctx) {
  let files =
    ctx.request.files.file.length > 1
      ? Array.from(ctx.request.files.file)
      : [ctx.request.files.file]

  const uploads = files.map(async file => {
    const fileExtension = [...file.name.split(".")].pop()
    // filenames converted to UUIDs so they are unique
    const processedFileName = `${uuid.v4()}.${fileExtension}`

    return prepareUpload({
      file,
      s3Key: `${ctx.appId}/attachments/${processedFileName}`,
      bucket: ObjectStoreBuckets.APPS,
    })
  })

  ctx.body = await Promise.all(uploads)
}

exports.serveApp = async function (ctx) {
  const db = getAppDB({ skip_setup: true })
  const appInfo = await db.get(DocumentTypes.APP_METADATA)
  let appId = getAppId()

  if (!env.isJest()) {
    const App = require("./templates/BudibaseApp.svelte").default
    const { head, html, css } = App.render({
      title: appInfo.name,
      production: env.isProd(),
      appId,
      clientLibPath: clientLibraryPath(appId, appInfo.version, ctx),
    })

    const appHbs = loadHandlebarsFile(`${__dirname}/templates/app.hbs`)
    ctx.body = await processString(appHbs, {
      head,
      body: html,
      style: css.code,
      appId,
    })
  } else {
    // just return the app info for jest to assert on
    ctx.body = appInfo
  }

  if (isDevAppID(appInfo.appId)) {
    await events.serve.servedAppPreview(appInfo)
  } else {
    await events.serve.servedApp(appInfo)
  }
}

exports.serveClientLibrary = async function (ctx) {
  return send(ctx, "budibase-client.js", {
    root: join(NODE_MODULES_PATH, "@budibase", "client", "dist"),
  })
}

exports.getSignedUploadURL = async function (ctx) {
  const database = getAppDB()

  // Ensure datasource is valid
  let datasource
  try {
    const { datasourceId } = ctx.params
    datasource = await database.get(datasourceId)
    if (!datasource) {
      ctx.throw(400, "The specified datasource could not be found")
    }
  } catch (error) {
    ctx.throw(400, "The specified datasource could not be found")
  }

  // Ensure we aren't using a custom endpoint
  if (datasource?.config?.endpoint) {
    ctx.throw(400, "S3 datasources with custom endpoints are not supported")
  }

  // Determine type of datasource and generate signed URL
  let signedUrl
  let publicUrl
  const awsRegion = datasource?.config?.region || "eu-west-1"
  if (datasource.source === "S3") {
    const { bucket, key } = ctx.request.body || {}
    if (!bucket || !key) {
      ctx.throw(400, "bucket and key values are required")
      return
    }
    try {
      const s3 = new AWS.S3({
        region: awsRegion,
        accessKeyId: datasource?.config?.accessKeyId,
        secretAccessKey: datasource?.config?.secretAccessKey,
        apiVersion: "2006-03-01",
        signatureVersion: "v4",
      })
      const params = { Bucket: bucket, Key: key }
      signedUrl = s3.getSignedUrl("putObject", params)
      publicUrl = `https://${bucket}.s3.${awsRegion}.amazonaws.com/${key}`
    } catch (error) {
      ctx.throw(400, error)
    }
  }

  ctx.body = { signedUrl, publicUrl }
}
