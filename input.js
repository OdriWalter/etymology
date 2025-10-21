// input.js - handle mouse interaction for painting, panning, zooming and path creation
export class Input {
  constructor(canvas, renderer, world) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.world = world;
    this.currentTileId = 0;
    this.isPanning = false;
    this.setupEvents();
  }

  setupEvents() {
    this.canvas.addEventListener('pointerdown', e => this.onPointerDown(e));
    this.canvas.addEventListener('pointermove', e => this.onPointerMove(e));
    this.canvas.addEventListener('pointerup', e => this.onPointerUp(e));
    this.canvas.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    // prevent context menu on right click
    this.canvas.addEventListener('contextmenu', e => e.preventDefault());
  }

  onPointerDown(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (e.button === 2) {
      // start panning
      this.isPanning = true;
      this.lastPanX = e.clientX;
      this.lastPanY = e.clientY;
    } else if (e.button === 0) {
      const worldPos = this.renderer.camera.screenToWorld(x, y);
      if (e.shiftKey) {
        const cart = this.world.selectedCart;
        if (cart) {
          const point = this.world.clampToBounds(worldPos.x, worldPos.y);
          cart.path.push(point);
          if (cart.path.length >= 2) {
            cart.computeSegments();
          }
        }
      } else {
        const point = this.world.clampToBounds(worldPos.x, worldPos.y);
        const selected = this.world.selectCartAt(point.x, point.y);
        if (!selected) {
          this.world.paintTile(point.x, point.y, this.currentTileId);
        }
      }
    }
  }

  onPointerMove(e) {
    if (this.isPanning && (e.buttons & 2)) {
      const dx = e.clientX - this.lastPanX;
      const dy = e.clientY - this.lastPanY;
      this.renderer.camera.x += dx;
      this.renderer.camera.y += dy;
      this.lastPanX = e.clientX;
      this.lastPanY = e.clientY;
    } else if ((e.buttons & 1) && !this.isPanning) {
      const rect = this.canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const worldPos = this.renderer.camera.screenToWorld(px, py);
      const point = this.world.clampToBounds(worldPos.x, worldPos.y);
      this.world.paintTile(point.x, point.y, this.currentTileId);
    }
  }

  onPointerUp(e) {
    if (e.button === 2) {
      this.isPanning = false;
    }
  }

  onWheel(e) {
    e.preventDefault();
    const scaleFactor = 1.1;
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const camera = this.renderer.camera;
    const worldBefore = camera.screenToWorld(px, py);
    let newScale = camera.scale;
    if (e.deltaY < 0) {
      newScale *= scaleFactor;
    } else {
      newScale /= scaleFactor;
    }
    newScale = Math.min(Math.max(newScale, 0.2), 5);
    camera.scale = newScale;
    camera.x = px - worldBefore.x * newScale;
    camera.y = py - worldBefore.y * newScale;
  }
}