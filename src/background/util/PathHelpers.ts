import { CanvasKit, ContourMeasure, Path as SkPath } from "canvaskit-wasm";
import simplify from "simplify-js";
import { RegularPolygon } from "./RegularPolygon";
import { CardinalSpline } from "./CardinalSpline";
import {
  Command,
  PathCommand,
  Shape,
  Vector2,
  Curve,
  Line,
  Path,
  isShape,
  isCurve,
  isPath,
  isLine,
} from "@owlbear-rodeo/sdk";
import { Drawing } from "../../types/Drawing";

const GOLDEN_RATIO = (Math.sqrt(5) - 1) / 2;

export interface ContourMarker {
  /** The distance on the contour */
  distance: number;
  /** The index of the contour  */
  index: number;
}

export interface PathIntersection {
  /** The point of intersection */
  point: Vector2;
  /** Distance to the point */
  distance: number;
  contour: ContourMarker;
}

export class PathHelpers {
  /**
   * Convert a CanvasKit SkPath into an OBR PathCommand array
   */
  static skPathToPathCommands(skPath: SkPath): PathCommand[] {
    const out: PathCommand[] = [];
    const cmds = skPath.toCmds();

    let current: PathCommand | null = null;
    for (const c of cmds) {
      if (!current) {
        current = [c];
      } else {
        current.push(c);
      }

      const maxLen = PathHelpers.getCommandLength(current[0]);
      if (current.length >= maxLen) {
        out.push(current);
        current = null;
      }
    }

    return out;
  }

  /**
   * Get how long the PathCommand is for a given Command verb
   */
  static getCommandLength(command: Command) {
    if (command === Command.CLOSE) {
      return 1;
    } else if (command === Command.MOVE) {
      return 3;
    } else if (command === Command.LINE) {
      return 3;
    } else if (command === Command.QUAD) {
      return 5;
    } else if (command === Command.CUBIC) {
      return 7;
    } else if (command === Command.CONIC) {
      return 6;
    }
    return 0;
  }

  /** Get the (x, y) point of an anchor from a path command */
  static getCommandPoint(command: PathCommand): Vector2 {
    const verb = command[0];
    switch (verb) {
      case Command.MOVE:
      case Command.LINE:
        return { x: command[1], y: command[2] };
      case Command.QUAD:
      case Command.CONIC:
        return { x: command[3], y: command[4] };
      case Command.CUBIC:
        return { x: command[5], y: command[6] };
      default:
        return { x: 0, y: 0 };
    }
  }

  /**
   * Sample a set of path commands by a fixed distance turning curves into a
   * fixed set of points
   */
  static samplePathCommands(
    CanvasKit: CanvasKit,
    commands: PathCommand[],
    distance: number
  ): Vector2[] {
    const skPath = CanvasKit.Path.MakeFromCmds(commands.flat());
    if (!skPath) {
      return [];
    }
    const points: Vector2[] = [];
    const iter = new CanvasKit.ContourMeasureIter(skPath, false, 1);
    let measure = iter.next();
    while (measure !== null) {
      const pathLength = measure.length();
      const numSamples = Math.ceil(pathLength / distance);
      for (let sample = 0; sample < numSamples; sample++) {
        const sampleDistance = Math.min(sample * distance, pathLength);
        const [x, y] = measure.getPosTan(sampleDistance);
        points.push({ x, y });
      }

      measure = iter.next();
    }
    skPath.delete();
    return simplify(points);
  }

  static commandsToPolylines(
    CanvasKit: CanvasKit,
    commands: PathCommand[],
    sampleDistance: number
  ) {
    const contours: Vector2[][] = [];
    // The points for this contour
    let points: Vector2[] = [];
    // The index into the commands array that this contour starts
    let contourStartIndex = 0;
    for (let index = 0; index < commands.length; index++) {
      const command = commands[index];
      const verb = command[0];

      const prevIndex = Math.max(index - 1, contourStartIndex);
      const prevCommand = commands[prevIndex];
      const startCommand = commands[contourStartIndex];

      switch (verb) {
        case Command.MOVE:
        case Command.LINE:
          // Add the point directly
          points.push(PathHelpers.getCommandPoint(command));
          break;
        case Command.QUAD:
        case Command.CONIC:
        case Command.CUBIC:
          if (prevCommand) {
            // Sample from the previous command to this command
            const prevAnchorPoint = PathHelpers.getCommandPoint(prevCommand);
            const subCommands: PathCommand[] = [
              [Command.MOVE, prevAnchorPoint.x, prevAnchorPoint.y],
              [...command],
            ];
            const samples = PathHelpers.samplePathCommands(
              CanvasKit,
              subCommands,
              sampleDistance
            );
            points.push(...samples);
          }
          break;
        case Command.CLOSE:
          // Add a point back to the start and start a new contour
          if (startCommand) {
            points.push(PathHelpers.getCommandPoint(startCommand));
          }
          contours.push(points);
          points = [];
          contourStartIndex = index + 1;
          break;
      }
    }

    if (points.length > 0) {
      // The contour didn't finish with a close command so use the remaining points
      contours.push(points);
    }

    const simplified = contours.map((points) => simplify(points));

    return simplified;
  }

  /**
   * Return an approximate nearest point and distance marker on one contour.
   * The query point and returned distances use the contour's local coordinates.
   * A zero-length or non-finite contour returns distance: Infinity.
   *
   * @param index Contour index to include in the returned marker.
   * @param tolerance Positive, finite maximum sampling interval. Refinement
   * targets an interval width of tolerance / 32, not a geometric error bound.
   * @param sample Optional scratch buffer of at least four floats; overwritten
   * during the search. The contour measure remains owned by the caller.
   */
  static getContourIntersection(
    measure: ContourMeasure,
    point: Vector2,
    index: number,
    tolerance = 8,
    sample = new Float32Array(4)
  ): PathIntersection {
    if (!Number.isFinite(tolerance) || tolerance <= 0) {
      throw new RangeError("Path nearest-point tolerance must be positive");
    }
    if (sample.length < 4) {
      throw new RangeError("Path nearest-point sample storage is too small");
    }
    const length = measure.length();
    let bestX = 0;
    let bestY = 0;
    let bestDistance = 0;
    let bestSquared = Infinity;
    const evaluate = (distance: number) => {
      measure.getPosTan(distance, sample);
      const dx = sample[0] - point.x;
      const dy = sample[1] - point.y;
      const squared = dx * dx + dy * dy;
      if (squared < bestSquared) {
        bestSquared = squared;
        bestDistance = distance;
        bestX = sample[0];
        bestY = sample[1];
      }
      return squared;
    };
    if (Number.isFinite(length) && length > 0) {
      const segments = Math.max(1, Math.ceil(length / tolerance));
      const interval = length / segments;
      for (let i = 0; i <= segments; i++) {
        evaluate(i === segments ? length : i * interval);
      }
      let low = Math.max(0, bestDistance - interval);
      let high = Math.min(length, bestDistance + interval);
      const targetWidth = Math.max(tolerance / 32, Number.EPSILON);
      if (high - low > targetWidth) {
        let left = high - (high - low) * GOLDEN_RATIO;
        let right = low + (high - low) * GOLDEN_RATIO;
        let leftSquared = evaluate(left);
        let rightSquared = evaluate(right);
        while (high - low > targetWidth) {
          // Golden-section spacing lets each narrower interval reuse one sample.
          if (leftSquared <= rightSquared) {
            high = right;
            right = left;
            rightSquared = leftSquared;
            left = high - (high - low) * GOLDEN_RATIO;
            if (left <= low || left >= right) break;
            leftSquared = evaluate(left);
          } else {
            low = left;
            left = right;
            leftSquared = rightSquared;
            right = low + (high - low) * GOLDEN_RATIO;
            if (right <= left || right >= high) break;
            rightSquared = evaluate(right);
          }
        }
      }
    }
    return {
      point: { x: bestX, y: bestY },
      distance: Math.sqrt(bestSquared),
      contour: { index, distance: bestDistance },
    };
  }

  static getSkPathIntersection(
    CanvasKit: CanvasKit,
    skPath: SkPath,
    point: Vector2
  ): PathIntersection {
    const iter = new CanvasKit.ContourMeasureIter(skPath, false, 1);
    let best: PathIntersection = {
      point: { x: 0, y: 0 },
      distance: Infinity,
      contour: { index: 0, distance: 0 },
    };
    let measure;
    let index = 0;
    const sample = new Float32Array(4);
    while ((measure = iter.next()) !== null) {
      const hit = PathHelpers.getContourIntersection(
        measure, point, index++, undefined, sample
      );
      if (hit.distance < best.distance) best = hit;
      measure.delete();
    }
    iter.delete();
    return best;
  }

  /**
   * Extract the segment between two absolute distance markers on one contour.
   * With shortestRoute, closed contours may wrap across the seam; ties use the
   * non-wrapping route, and segments at most 0.001 local units return null.
   * Mismatched or missing contours return null. The caller owns the returned
   * path and must delete it; the source path is not modified.
   */
  static getSkPathBetween(
    CanvasKit: CanvasKit,
    skPath: SkPath,
    start: ContourMarker,
    end: ContourMarker,
    shortestRoute = false
  ): SkPath | null {
    if (start.index !== end.index) return null;
    const iter = new CanvasKit.ContourMeasureIter(skPath, false, 1);
    let measure;
    let index = 0;
    try {
      while ((measure = iter.next()) !== null) {
        try {
          if (index++ !== start.index) continue;
          const length = measure.length();
          const low = Math.min(start.distance, end.distance);
          const high = Math.max(start.distance, end.distance);
          if (shortestRoute && (length <= 0 || high - low <= 0.001)) return null;
          if (shortestRoute && measure.isClosed() && high - low > length / 2) {
            if (length - high + low <= 0.001) return null;
            const segment = measure.getSegment(high, length, true);
            const head = measure.getSegment(0, low, true);
            // Extend mode joins the seam into one contour for midpoint measurement.
            segment.addPath(head, true);
            head.delete();
            return segment;
          }
          return measure.getSegment(low, high, true);
        } finally {
          measure.delete();
        }
      }
      return null;
    } finally {
      iter.delete();
    }
  }

  static getCommandsBetween(
    CanvasKit: CanvasKit,
    skPath: SkPath,
    start: ContourMarker,
    end: ContourMarker
  ): PathCommand[] | null {
    const segment = PathHelpers.getSkPathBetween(CanvasKit, skPath, start, end);
    if (!segment) {
      return null;
    }
    const commands = PathHelpers.skPathToPathCommands(segment);
    segment.delete();
    return commands;
  }

  static getSkPathPoint(
    CanvasKit: CanvasKit,
    skPath: SkPath,
    percentDistance = 0.5,
    contour = 0
  ): Vector2 | null {
    const iter = new CanvasKit.ContourMeasureIter(skPath, false, 1);
    let measure;
    let index = 0;
    try {
      while ((measure = iter.next()) !== null) {
        try {
          if (index++ !== contour) continue;
          const [x, y] = measure.getPosTan(measure.length() * percentDistance);
          return { x, y };
        } finally {
          measure.delete();
        }
      }
      return null;
    } finally {
      iter.delete();
    }
  }

  /**
   * Convert an OBR Shape into a CanvasKit SkPath
   */
  static shapeToSkPath(CanvasKit: CanvasKit, shape: Shape, out?: SkPath) {
    const skPath = out ?? new CanvasKit.Path();
    if (shape.shapeType === "RECTANGLE") {
      skPath.addRect(CanvasKit.XYWHRect(0, 0, shape.width, shape.height));
    } else if (shape.shapeType === "CIRCLE") {
      skPath.addOval(
        CanvasKit.XYWHRect(
          -shape.width / 2,
          -shape.height / 2,
          shape.width,
          shape.height
        )
      );
    } else if (shape.shapeType === "TRIANGLE") {
      skPath.moveTo(0, 0);
      skPath.lineTo(shape.width / 2, shape.height);
      skPath.lineTo(-shape.width / 2, shape.height);
      skPath.close();
    } else if (shape.shapeType === "HEXAGON") {
      const radius = Math.min(shape.width, shape.height) / 2;
      RegularPolygon.addToSkPath(skPath, radius, 6);
    } else {
      throw Error("Unable to get path for shape: path type not implemented");
    }
    return skPath;
  }

  /**
   * Convert an OBR Path into a CanvasKit SkPath
   */
  static pathToSkPath(CanvasKit: CanvasKit, path: Path) {
    const skPath = CanvasKit.Path.MakeFromCmds(path.commands.flat());
    const fillType =
      path.fillRule === "nonzero"
        ? CanvasKit.FillType.Winding
        : CanvasKit.FillType.EvenOdd;
    skPath?.setFillType(fillType);
    return skPath;
  }

  /**
   * Convert an OBR Curve into a CanvasKit SkPath
   */
  static curveToSkPath(CanvasKit: CanvasKit, curveData: Curve, out?: SkPath) {
    const skPath = out ?? new CanvasKit.Path();

    const tension = curveData.style.tension;
    const closed =
      curveData.style.fillOpacity > 0 || Boolean(curveData.style.closed);
    CardinalSpline.addToSkPath(skPath, curveData.points, tension, closed);

    return skPath;
  }

  /**
   * Convert an OBR Line into a CanvasKit SkPath
   */
  static lineToSkPath(CanvasKit: CanvasKit, line: Line, out?: SkPath) {
    const path = out ?? new CanvasKit.Path();

    path.moveTo(line.startPosition.x, line.startPosition.y);
    path.lineTo(line.endPosition.x, line.endPosition.y);

    return path;
  }

  /**
   * Convert any OBR drawing into a CanvasKit SkPath
   */
  static drawingToSkPath(
    drawing: Drawing,
    CanvasKit: CanvasKit
  ): SkPath | null {
    if (isShape(drawing)) {
      return PathHelpers.shapeToSkPath(CanvasKit, drawing);
    } else if (isCurve(drawing)) {
      return PathHelpers.curveToSkPath(CanvasKit, drawing);
    } else if (isPath(drawing)) {
      return PathHelpers.pathToSkPath(CanvasKit, drawing);
    } else if (isLine(drawing)) {
      return PathHelpers.lineToSkPath(CanvasKit, drawing);
    }

    return null;
  }
}
