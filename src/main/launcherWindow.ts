/** Clamp renderer content and the native frame to the current display's work area. */
export function contentWindowBounds(
  contentHeight: number,
  bounds: { x: number; y: number; width: number; height: number },
  content: { width: number; height: number },
  workArea: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(Math.ceil(contentHeight) + bounds.height - content.height, workArea.height);
  return {
    x: Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - height)),
    width,
    height,
  };
}
