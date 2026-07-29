export type StitchedGrid = {
  gridDataUrl: string;
  cols: number;
  rows: number;
  cellFrames: { t: number; cellIndex: number; cellLabel: string }[];
};

/**
 * Loads an image from a data URL into an HTMLImageElement.
 */
function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = dataUrl;
  });
}

/**
 * Stitches an array of frames into a single composite grid image (e.g. 2x2 or 3x3)
 * with timestamp badges overlaid on top-left of each cell.
 */
export async function stitchFramesIntoGrid(
  frames: { t: number; dataUrl: string }[],
  mode: "2x2" | "3x3" = "3x3",
  cellWidth = 320,
): Promise<StitchedGrid> {
  if (frames.length === 0) {
    throw new Error("No frames provided for grid stitching");
  }

  const cols = mode === "2x2" ? 2 : 3;
  const rows = Math.ceil(frames.length / cols);

  // Load all images in parallel
  const images = await Promise.all(
    frames.map((f) => loadImage(f.dataUrl).catch(() => null)),
  );

  // Determine cell aspect ratio from first valid image
  const firstImg = images.find(Boolean);
  const aspect = firstImg ? firstImg.height / firstImg.width : 0.5625; // default 16:9
  const cellHeight = Math.round(cellWidth * aspect);

  const canvasWidth = cols * cellWidth;
  const canvasHeight = rows * cellHeight;

  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  // Dark background
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  const cellFrames: { t: number; cellIndex: number; cellLabel: string }[] = [];

  for (let i = 0; i < frames.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * cellWidth;
    const y = row * cellHeight;

    const img = images[i];
    if (img) {
      ctx.drawImage(img, x, y, cellWidth, cellHeight);
    } else {
      ctx.fillStyle = "#1e293b";
      ctx.fillRect(x, y, cellWidth, cellHeight);
    }

    // Grid border line
    ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, cellWidth, cellHeight);

    // Overlay timestamp badge (e.g., "#1 @ 2.7s")
    const label = `#${i + 1} @ ${frames[i].t.toFixed(1)}s`;
    cellFrames.push({ t: frames[i].t, cellIndex: i + 1, cellLabel: label });

    // Draw pill badge
    ctx.font = "bold 13px system-ui, sans-serif";
    const textMetrics = ctx.measureText(label);
    const paddingX = 8;
    const badgeW = textMetrics.width + paddingX * 2;
    const badgeH = 22;
    const badgeX = x + 8;
    const badgeY = y + 8;

    ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
    ctx.beginPath();
    ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 4);
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, badgeX + paddingX, badgeY + 16);
  }

  const gridDataUrl = canvas.toDataURL("image/jpeg", 0.75);

  return {
    gridDataUrl,
    cols,
    rows,
    cellFrames,
  };
}
