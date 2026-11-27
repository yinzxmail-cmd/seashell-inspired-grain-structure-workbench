# Seashell-Inspired Grain Structure Workbench

**[Open the live workbench](https://yinzxmail-cmd.github.io/seashell-inspired-grain-structure-workbench/)**

Design layered hexagonal grain structures inspired by seashell microstructures. Set grain orientations and layer offsets, inspect the deposited strands in 3D, and export the mesh, data, or printer toolpaths. The workbench runs entirely in the browser.

## Quick start

1. Under **Geometry**, set the specimen length, width, and hexagon edge length in millimeters. The angle controls offer 30°, 60°, 90°, 150°, and a custom angle with both a slider and numeric input from 0° to 180°.
2. Choose a programming mode and set **Total layers** at the top left of the preview.
3. Under **Layer Stacking**, choose a repeating αβγ or ααα preset. For a custom sequence, choose whether to specify each layer or repeat a cycle.
4. Drag to rotate, scroll to zoom, or right-drag to pan. On a touchscreen, drag with one finger to rotate, pinch to zoom, and drag with two fingers to pan. **Reset** restores the default view.
5. Choose **Export** to download the project settings, geometry, or toolpaths.

## Programming modes

| Mode | What you edit |
| --- | --- |
| **Point Programming** | **In-layer Layout** lists the three positions for each numbered layer. **Repeated units** tiles that layer's unit vertically and along both diagonals. **Custom** provides individual grain edits. |
| **Line Programming** | In **Geometry**, choose one or two distinct directions from 0°, 60°, 90°, and 120°. Each family supports a cycle of line angles or individual line edits. The selected direction is highlighted through the central grain. |
| **Face Programming** | Each grain on a layer shares one angle, and every active layer uses a different orientation. Layer stacking controls physical offsets independently. |

Select a position in the diagram or click the specimen to highlight its grain. Use an angle control or the hexagonal color swatches above the model. The full color picker and the six presets affect the selected grain's display color. Click outside the selection or press Esc to clear the highlight.

With two line directions, the center grain is the coordinate origin. Each grain uses the angle of the intersecting line from strand 1 if the sum of the two oblique coordinates is odd, or from strand 2 if it is even. The perpendicular pair uses staggered half-step positions where needed, with an integral coordinate sum.

In ααα stacking, all layers share the same lattice and grain centers align. In αβγ, the three layers occupy distinct lattice positions. In the cyclic order a center on the upper layer projects to a vertex of a lower-layer hexagon. For edge length s with screen Y pointing down, one coordinate convention for (α, β, γ) is (0, 0), (−√3s/2, −s/2), and (0, −s). The positions are equivalent up to whole lattice translations. [Yu et al., Fig. 3a and Methods](https://www.nature.com/articles/s41467-024-53850-w.pdf)

Sample dimensions are shared across all three modes. When you switch modes with unsaved edits, **Save and stay** downloads an editable project file and keeps the mode open. **Discard and switch** returns the current mode to its last saved settings and opens the requested mode. Use **Export → Open project** to continue from a saved file.

Select a grain and choose **Delete** to remove it from the model and exports. Point and Line Programming remove the grain on the selected layer. Face Programming removes the corresponding position from every layer. **Undo delete** restores the most recent removal in the current mode.

## Preview and geometry

- **Printed strands** shows the complete stack. **Printed layer** isolates the selected layer. **Solid grains** shows the underlying hexagons.
- The layer height is half the selected strand width. A nominal width of **0.60 mm** gives a **0.30 mm** layer height. A road that is lengthened redistributes its original extrusion volume along the longer path. The preview uses its corresponding bead width. [Slic3r flow model](https://manual.slic3r.org/advanced/flow-math)
- The printed preview, STL, 3MF, and G-code use the same deposition paths. Adjacent grains overlap at shared edges by extending or repositioning their existing oriented strands. Layer spacing equals layer height. Dashed gray marks identify grains that cannot fit a stroke at the chosen width.
- **Merge matching grains** lays out adjacent grains with the same orientation on a shared grid of parallel strands. A strand that crosses a shared edge prints in a continuous extrusion move. The region keeps its original material volume. Strands running parallel to a seam or separated by a gap remain separate. The preview reports the continuous strokes on the selected layer.
- The 3D view uses WebGL 2. If the renderer fails, an SVG preview is shown. **Retry 3D** restarts the renderer.

## Export formats

| Format | Contents |
| --- | --- |
| **STL** | Binary mesh of the complete strand stack. Select millimeters when importing if your slicer asks for a unit. |
| **3MF** | Mesh of the complete strand stack with millimeters specified in the file. |
| **G-code** | Oriented extrusion moves, including continuous strands across equal-angle grains when merging is enabled. Travel, lift, and retraction occur between strokes. |
| **Project (.json)** | Editable dimensions, layer settings, and mode edits. |
| **CSV** | Grain centers, orientations, layer offsets, and clipped outlines. |
| **SVG** | A projected preview of the specimen. |

G-code prints the stack from the bottom up and completes all strokes of one orientation within a layer before switching to the next. Export checks the build volume and requires each layer to have printable strokes. The file targets a single-extruder Marlin-compatible printer with a positive XY bed origin. Set the build volume, filament diameter, and temperatures in the export dialog. [Marlin linear moves](https://marlinfw.org/docs/gcode/G000-G001.html)

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
