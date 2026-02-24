import path from "node:path";
import { writeBase64ToFile } from "./nodes-camera.js";
import { asNumber, asRecord, asString, resolveTempPathParts } from "./nodes-media-utils.js";

export type DesktopSnapshotPayload = {
  format: string;
  base64: string;
  width?: number;
  height?: number;
  screenWidth?: number;
  screenHeight?: number;
  scaleFactor?: number;
};

export function parseDesktopSnapshotPayload(value: unknown): DesktopSnapshotPayload {
  const obj = asRecord(value);
  const format = asString(obj.format);
  const base64 = asString(obj.base64);
  if (!format || !base64) {
    throw new Error("invalid desktop.snapshot payload");
  }
  const width = asNumber(obj.width);
  const height = asNumber(obj.height);
  const screenWidth = asNumber(obj.screenWidth);
  const screenHeight = asNumber(obj.screenHeight);
  const scaleFactor = asNumber(obj.scaleFactor);
  return {
    format,
    base64,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(screenWidth !== undefined ? { screenWidth } : {}),
    ...(screenHeight !== undefined ? { screenHeight } : {}),
    ...(scaleFactor !== undefined ? { scaleFactor } : {}),
  };
}

export function desktopSnapshotTempPath(opts: { ext: string; tmpDir?: string; id?: string }) {
  const { tmpDir, id, ext } = resolveTempPathParts(opts);
  return path.join(tmpDir, `openclaw-desktop-snapshot-${id}${ext}`);
}

export async function writeDesktopSnapshotToFile(filePath: string, base64: string) {
  return await writeBase64ToFile(filePath, base64);
}
