const COVER_SIZE = 96;

export async function shrinkCover(source) {
  try {
    const blob = source instanceof Blob ? source : await fetch(source).then((r) => {
      if (!r.ok) throw new Error('cover');
      return r.blob();
    });
    const bitmap = await createImageBitmap(blob);
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = COVER_SIZE;
    canvas.height = COVER_SIZE;
    canvas.getContext('2d').drawImage(
      bitmap,
      (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side,
      0, 0, COVER_SIZE, COVER_SIZE,
    );
    bitmap.close?.();
    return canvas.toDataURL('image/jpeg', 0.62);
  } catch {
    return null;
  }
}
