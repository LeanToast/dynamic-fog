import { CanvasKit, Path as SkPath } from "canvaskit-wasm";
import { PathCommand } from "@owlbear-rodeo/sdk";
import { Door } from "../../types/Door";
import { ContourMarker, PathHelpers } from "./PathHelpers";

export class DoorHelpers {
  /**
   * Return the door segment as item-local path commands, or null if it cannot
   * be extracted. Uses the same endpoint and route rules as getDoorSkPath.
   */
  static getDoorCommands(
    CanvasKit: CanvasKit,
    path: SkPath,
    door: Door
  ): PathCommand[] | null {
    const segment = DoorHelpers.getDoorSkPath(CanvasKit, path, door);
    if (!segment) return null;
    try {
      return PathHelpers.skPathToPathCommands(segment);
    } finally {
      segment.delete();
    }
  }

  /**
   * Extract an item-local door segment from a path. Vector endpoints project
   * onto the contour with the smallest combined endpoint distance and take
   * the shorter route on closed contours. Legacy markers use their stored
   * contour distances without wrapping.
   * Returns null if no segment can be extracted. The caller must delete the
   * returned path. The source path and door metadata are not modified.
   */
  static getDoorSkPath(CanvasKit: CanvasKit, path: SkPath, door: Door) {
    if ("distance" in door.start && "distance" in door.end) {
      return PathHelpers.getSkPathBetween(CanvasKit, path, door.start, door.end);
    }
    if (!("x" in door.start) || !("x" in door.end)) return null;
    if (![door.start.x, door.start.y, door.end.x, door.end.y].every(Number.isFinite)) {
      return null;
    }

    const iter = new CanvasKit.ContourMeasureIter(path, false, 1);
    let best: { start: ContourMarker; end: ContourMarker } | null = null;
    let error = Infinity;
    let index = 0;
    let measure;
    const sample = new Float32Array(4);
    while ((measure = iter.next()) !== null) {
      const start = PathHelpers.getContourIntersection(
        measure, door.start, index, undefined, sample
      );
      const end = PathHelpers.getContourIntersection(
        measure, door.end, index, undefined, sample
      );
      // Scoring the pair prevents nearby contours from splitting the endpoints.
      if (start.distance + end.distance < error) {
        error = start.distance + end.distance;
        best = { start: start.contour, end: end.contour };
      }
      measure.delete();
      index++;
    }
    iter.delete();
    return best
      ? PathHelpers.getSkPathBetween(CanvasKit, path, best.start, best.end, true)
      : null;
  }
}
