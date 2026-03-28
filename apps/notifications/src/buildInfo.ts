import fs from 'fs'
import path from 'path'

export type BuildInfo = {
  /** Git SHA baked at image build or set in k8s env */
  gitCommit: string
  /** Docker / registry tag or release label */
  imageTag: string
  /** ISO-ish timestamp from build pipeline */
  buildTime: string
  /** @pedalboard/notifications version from package.json */
  packageVersion: string
}

let cachedPackageVersion: string | undefined

function readPackageVersion(): string {
  if (cachedPackageVersion !== undefined) {
    return cachedPackageVersion
  }
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      version?: string
    }
    cachedPackageVersion = pkg.version ?? 'unknown'
  } catch {
    cachedPackageVersion = 'unknown'
  }
  return cachedPackageVersion
}

/**
 * Identifies the running artifact: git SHA, image tag, build time, npm version.
 * Set via Dockerfile ARG/ENV or k8s deployment env (GIT_COMMIT, IMAGE_TAG, BUILD_TIME).
 */
export function getBuildInfo(): BuildInfo {
  return {
    gitCommit:
      process.env.GIT_COMMIT ??
      process.env.GITHUB_SHA ??
      process.env.VERCEL_GIT_COMMIT_SHA ??
      'unknown',
    imageTag:
      process.env.IMAGE_TAG ??
      process.env.DOCKER_IMAGE_TAG ??
      process.env.CI_IMAGE_TAG ??
      'unknown',
    buildTime: process.env.BUILD_TIME ?? 'unknown',
    packageVersion: readPackageVersion()
  }
}
