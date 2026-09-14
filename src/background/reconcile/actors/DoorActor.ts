import { Item, MathM } from "@owlbear-rodeo/sdk";
import { Path as SkPath } from "canvaskit-wasm";
import { Actor } from "../Actor";
import { Reconciler } from "../Reconciler";
import { getMetadata } from "../../../util/getMetadata";
import { getPluginId } from "../../../util/getPluginId";
import { Door } from "../../../types/Door";
import { Drawing, isDrawing } from "../../../types/Drawing";
import { PathHelpers } from "../../util/PathHelpers";
import { DoorHelpers } from "../../util/DoorHelpers";

export interface DoorComponent {
  base: Door;
  // Current stroked door in world space
  skPath: SkPath;
}

export class DoorActor extends Actor {
  doors: DoorComponent[] = [];
  constructor(reconciler: Reconciler, parent: Item) {
    super(reconciler);
    if (isDrawing(parent)) {
      this.doors = this.drawingToDoorComponents(parent);
    }
  }

  delete(): void {
    for (const door of this.doors) {
      door.skPath.delete();
    }
  }

  update(parent: Item) {
    if (!isDrawing(parent)) {
      return;
    }
    // Invalid doors are omitted, so component positions cannot index metadata.
    // Rebuilding also removes openings whose geometry is no longer valid.
    this.delete();
    this.doors = this.drawingToDoorComponents(parent);
  }

  private drawingToDoorComponents(drawing: Drawing): DoorComponent[] {
    const visuals: DoorComponent[] = [];
    const doors = getMetadata<Door[]>(
      drawing.metadata,
      getPluginId("doors"),
      []
    );
    for (const door of doors) {
      const visual = this.doorToDoorComponent(drawing, door);
      if (!visual) {
        continue;
      }
      visuals.push(visual);
    }
    return visuals;
  }

  private doorToDoorComponent(
    drawing: Drawing,
    door: Door
  ): DoorComponent | null {
    const skPath = this.getDoorSkPath(drawing, door);
    if (!skPath) {
      return null;
    }
    return {
      base: door,
      skPath: skPath,
    };
  }

  private getDoorSkPath(drawing: Drawing, door: Door) {
    const skPath = PathHelpers.drawingToSkPath(
      drawing,
      this.reconciler.CanvasKit
    );
    if (!skPath) {
      return null;
    }
    const segment = DoorHelpers.getDoorSkPath(this.reconciler.CanvasKit, skPath, door);
    skPath.delete();
    if (!segment) {
      return null;
    }
    segment.stroke({
      // Add a buffer to account for the segmentation of curves and
      // imperfect alignments
      width: drawing.style.strokeWidth + 20,
    });

    // Transform segment into world space
    const transform = MathM.fromItem(drawing);
    segment.transform(...transform);

    return segment;
  }
}
