// electron-builder afterPack hook: ad-hoc code-sign the macOS .app.
//
// Why: we ship unsigned (no Apple Developer cert), and electron-builder with
// identity:null leaves a stale signature whose identifier is "Electron",
// mismatching our bundle id — which breaks macOS Screen Recording permission
// (the app won't appear/toggle in System Settings). An ad-hoc signature gives
// the bundle a stable identity macOS TCC can track. This runs BEFORE the DMG is
// assembled, so the signed .app is what gets packaged.
//
// Note: ad-hoc signatures change every build (cdhash), so each rebuild needs the
// Screen Recording permission re-granted. That's inherent to unsigned distribution.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  console.log(`[afterPack] ad-hoc signing ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });

  // Sanity-check the signature so a broken sign fails the build loudly.
  execFileSync('codesign', ['--verify', '--strict', appPath], { stdio: 'inherit' });
  console.log('[afterPack] ad-hoc sign verified OK');
};
