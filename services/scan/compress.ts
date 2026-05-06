import * as ImageManipulator from 'expo-image-manipulator';

const MAX_BASE64_BYTES = 1_400_000;
const RESIZE_STEPS = [1600, 1200, 900];
const COMPRESS_STEPS = [0.6, 0.45, 0.3];

export interface CompressedImage {
  base64: string;
  width: number;
  height: number;
}

export async function compressForUpload(uri: string): Promise<CompressedImage> {
  let last: CompressedImage | null = null;

  for (const width of RESIZE_STEPS) {
    for (const compress of COMPRESS_STEPS) {
      const result = await ImageManipulator.manipulateAsync(
        uri,
        [{ resize: { width } }],
        {
          compress,
          format: ImageManipulator.SaveFormat.JPEG,
          base64: true,
        },
      );
      if (!result.base64) continue;
      last = { base64: result.base64, width: result.width, height: result.height };
      if (result.base64.length <= MAX_BASE64_BYTES) {
        return last;
      }
    }
  }

  if (!last) throw new Error('Failed to compress image');
  return last;
}
