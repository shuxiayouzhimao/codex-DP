import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * 启动时静默检查更新：有新版本 → 下载安装 → 重启应用。
 * 全程静默：无网络 / 无 release / 端点 404 等全部吞掉，绝不打扰桌宠。
 * （Windows NSIS 更新为静默安装，relaunch 时宠物会重启一下，属正常。）
 */
export async function checkForUpdates(): Promise<void> {
  try {
    const update = await check();
    if (!update) return;
    console.log(`[pet-updater] 发现新版本 ${update.version}，开始更新…`);
    await update.downloadAndInstall();
    await relaunch();
  } catch (e) {
    console.log("[pet-updater] 检查更新跳过:", e);
  }
}
