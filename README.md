# Seashell-Inspired Grain Structure Workbench

**[Open the live workbench](https://yinzxmail-cmd.github.io/seashell-inspired-grain-structure-workbench/)**

Design layered hexagonal grain structures inspired by seashell microstructures. The workbench lets you set grain orientations, experiment with layer offsets, inspect the resulting filament geometry in 3D, and export the strand stack for slicing. It runs entirely in the browser.

## Quick start

1. Under **Geometry**, set the specimen length, width, and hexagon edge length in millimeters. A three-grain unit can combine the fixed orientations 30°, 90°, and 150°.
2. Choose a programming mode, then set the layer count under **In-layer Layout**.
3. Under **Layer Stacking**, choose a preset or enter an offset sequence using α, β, and γ. A custom sequence can be specified for every layer or repeated as a cycle.
4. Drag to rotate, scroll to zoom, or right-drag to pan. On a touchscreen, drag with one finger to rotate, pinch to zoom, and drag with two fingers to pan. **Reset** restores the default view.
5. Choose **Export** and select a mesh or data format.

## Programming modes

| Mode | What you edit |
| --- | --- |
| **Point Programming** | **Repeat units** tiles the configured three-grain units. **Custom** lets you select a grain and override its angle on that layer. |
| **Line Programming** | Grains in a column on the selected layer share one angle. Pick a layer and column in **In-layer Layout**, or click a grain to select its column. Keep the layers independent or repeat column templates over a specified cycle. |
| **Plane Programming** | Build a pattern sequence for the first layer. **Repeat units** tiles the sequence, while **Custom** lets you override a grain at the corresponding position in every layer. Each layer then uses its own stacking offset. |

Sample dimensions are shared across all three modes. Each mode retains its layer and stacking settings while you switch between modes in the same session. **Clear** or Esc clears the selected grain.

Select a grain and choose **Delete** to remove it from the model and exports. Point and Line Programming remove the grain on the selected layer. Plane Programming removes the corresponding position from the shared template on every layer. **Undo delete** restores the most recent removal in the current mode.

## Preview and geometry

- **Printed strands** shows the complete stack. **Printed layer** isolates the selected layer. **Solid grains** shows the underlying hexagons.
- The deposited strand height is always half its width. A width of **0.60 mm** gives a **0.30 mm** layer height. Strands retain their full width at cell boundaries. Their flattened cross-section has rounded sides and planar end faces. [Slic3r flow model](https://manual.slic3r.org/advanced/flow-math)
- The minimum separation is **10% of the strand width**, or **0.06 mm** at the default. It applies between neighboring strands, across grain boundaries, and between layers. Dashed gray marks indicate uncovered areas.
- The 3D view uses WebGL 2. If the renderer fails, an SVG preview is shown. **Retry 3D** restarts the renderer.

## Export formats

| Format | Contents |
| --- | --- |
| **STL** | Binary mesh of the complete strand stack. Select millimeters when importing if your slicer asks for a unit. |
| **3MF** | Mesh of the complete strand stack with millimeters specified in the file. |
| **CSV** | Grain centers, orientations, layer offsets, and clipped outlines. |
| **SVG** | A projected preview of the specimen. |

STL and 3MF preserve the strand gaps and layer offsets. The upper strands can be suspended because the strands are separate. Check the slicer's support settings, toolpaths, and minimum feature resolution before printing.

## Run locally or develop

Download the repository and open `index.html` in a browser. Keep `grain-3d.bundle.js` beside it for 3D and mesh export.

```sh
npm ci
npm run build
npx playwright install chromium
npm test
```

When editing the 3D or export modules, rebuild `grain-3d.bundle.js` before publishing. To test against an installed Chromium-based browser, set `GRAIN_TEST_CHROMIUM` to its executable path and run `npm test`.

## References and dependencies

- Structural inspiration from [Yu et al., Nature Communications (2024)](https://doi.org/10.1038/s41467-024-53850-w).
- Interface inspiration from [Pretty Lattice](https://github.com/songfeitong/pretty-lattice).
- 3D rendering uses Three.js. ZIP packaging for 3MF uses fflate. See the [Three.js license](THREE-LICENSE.txt) and [fflate license](FFLATE-LICENSE.txt).
