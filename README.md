# Seashell-Inspired Grain Structure Workbench

A browser-based tool for generating, viewing, and exporting layered hexagonal grain structures inspired by seashells.

## Live demo

[Open the Workbench](https://yinzxmail-cmd.github.io/seashell-inspired-grain-structure-workbench/)

## Getting started

1. Open the live demo or download the repository and open `index.html` in a browser. The 3D bundle is included, so both methods work without installing dependencies. If you open a copy of `index.html` by itself, the original SVG views are available.
2. In **Geometry**, enter the sample dimensions and hexagon edge length. Edit the three orientations within each cell pattern.
3. In **In-layer Layout**, specify the total layers and pattern sequences. In **Layer Stacking**, select ααα or αβγ, or enter a custom sequence using α, β, and γ.
4. In **3D**, drag with the left mouse button to rotate, scroll to zoom, and drag with the right mouse button to pan. Click **Reset** to fit the stack and restore its default angle. Selecting a deeper layer fades the layers above it. The 3D view shows a small gap between layers for readability.
5. Switch to **Isometric** or **Top** for the original SVG views, where drag pans and scroll zooms. Export either current SVG view, use **Export Isometric SVG** in 3D, or download a CSV of cell positions and clipped outlines from any view.

The 3D view requires WebGL 2. If the graphics context is lost, the workbench restores the latest valid model when the browser restores WebGL. Use **Retry 3D** to restart the renderer or switch to an SVG view.

## Development

Run `npm ci` to install the pinned development dependencies. Run `npm run build` after editing `src/grain-3d.js` and commit the regenerated `grain-3d.bundle.js` with the source so the static site and local copies can load 3D.

Run `npx playwright install chromium` and `npm test` to run the browser tests. To use an existing Chromium-based browser, set `GRAIN_TEST_CHROMIUM` to the browser executable and run `npm test`.

## References

- Interface inspiration: [Pretty Lattice](https://github.com/songfeitong/pretty-lattice).
- Structural inspiration: [Yu et al., Nature Communications (2024)](https://doi.org/10.1038/s41467-024-53850-w).
