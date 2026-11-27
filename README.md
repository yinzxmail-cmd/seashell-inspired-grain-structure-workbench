# Seashell-Inspired Grain Structure Workbench

**[Open the live workbench](https://yinzxmail-cmd.github.io/seashell-inspired-grain-structure-workbench/)**

Design layered hexagonal grain structures inspired by seashell microstructures. Set grain orientations and layer offsets, inspect the deposited strands in 3D, and export the mesh, data, or printer toolpaths. The workbench runs entirely in the browser.

## Quick start

1. Under **Geometry**, set the specimen length, width, and hexagon edge length in millimeters. A three-grain unit can combine the fixed orientations 30°, 90°, and 150°.
2. Choose a programming mode, then set the layer count under **In-layer Layout**.
3. Under **Layer Stacking**, choose a repeating αβγ or ααα preset. For a custom sequence, choose whether to specify each layer or repeat a cycle.
4. Drag to rotate, scroll to zoom, or right-drag to pan. On a touchscreen, drag with one finger to rotate, pinch to zoom, and drag with two fingers to pan. **Reset** restores the default view.
5. Choose **Export** to download the project settings, geometry, or toolpaths.

## Programming modes

| Mode | What you edit |
| --- | --- |
| **Point Programming** | Choose a numbered layer in **Cell Patterns**. **Repeated units** tiles that layer's own three-grain unit vertically and along both diagonals. **Custom** lets consecutive units on that layer have different grain angles. |
| **Line Programming** | Grains in a column on the selected layer share one angle. Pick a layer and column in **In-layer Layout**, or click a grain to select its column. Keep the layers independent or repeat column templates over a specified cycle. |
| **Plane Programming** | **Repeated units** cycles the first-layer sequence vertically and along both diagonals. **Custom** places the specified pattern numbers once, uses Pattern 1 for the remaining units, and lets you edit individual grains. The other layers use the first-layer assignments and their own stacking offsets. |

Select a position in the three-grain diagram to highlight the corresponding grain in the current layer's center unit. Pick a fixed angle in either the 3D view or the diagram. Repeat mode updates matching unit positions. Custom mode edits that grain in the layer pattern. Click outside the selection or press Esc to clear the highlight. The diagram keeps showing the edited angles.

Sample dimensions are shared across all three modes. When you switch modes with unsaved edits, **Save and stay** downloads an editable project file and keeps the mode open. **Discard and switch** returns the current mode to its last saved settings and opens the requested mode. Use **Export → Open project** to continue from a saved file.

Select a grain and choose **Delete** to remove it from the model and exports. Point and Line Programming remove the grain on the selected layer. Plane Programming removes the corresponding position from the shared template on every layer. **Undo delete** restores the most recent removal in the current mode.

## Preview and geometry

- **Printed strands** shows the complete stack. **Printed layer** isolates the selected layer. **Solid grains** shows the underlying hexagons.
- The deposited strand height is always half its width. A width of **0.60 mm** gives a **0.30 mm** layer height. Strands retain their full width at cell boundaries. Their flattened cross-section has rounded sides and planar end faces. [Slic3r flow model](https://manual.slic3r.org/advanced/flow-math)
- Layer spacing equals strand height, so adjacent layers meet wherever their roads overlap. The mesh preview retains a minimum in-layer strand separation of **10% of the strand width**, or **0.06 mm** at the default. Dashed gray marks indicate uncovered areas.
- The 3D view uses WebGL 2. If the renderer fails, an SVG preview is shown. **Retry 3D** restarts the renderer.

## Export formats

| Format | Contents |
| --- | --- |
| **STL** | Binary mesh of the complete strand stack. Select millimeters when importing if your slicer asks for a unit. |
| **3MF** | Mesh of the complete strand stack with millimeters specified in the file. |
| **G-code** | Printer moves with individually started, stopped, and retracted strokes. Separate perimeter roads overlap across shared grain boundaries. |
| **Project (.json)** | Editable dimensions, layer settings, and mode edits. |
| **CSV** | Grain centers, orientations, layer offsets, and clipped outlines. |
| **SVG** | A projected preview of the specimen. |

STL and 3MF preserve the in-layer mesh gaps and layer offsets. G-code adds separate perimeter strokes to join adjacent grains within a layer and prints the stack from the bottom up. Export checks the build volume and requires each layer to have printable strokes. The file targets a single-extruder Marlin-compatible printer with a positive XY bed origin. Set the build volume, filament diameter, and temperatures in the export dialog. [Marlin linear moves](https://marlinfw.org/docs/gcode/G000-G001.html)

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
