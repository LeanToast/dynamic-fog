import { Vector2 } from "@owlbear-rodeo/sdk";
import { ContourMarker } from "../background/util/PathHelpers";

/**
 * A door with either legacy absolute contour-distance markers or item-local
 * point anchors. Both endpoints must use the same format.
 */
export type Door =
  | { open: boolean; start: ContourMarker; end: ContourMarker }
  | { open: boolean; start: Vector2; end: Vector2 };
