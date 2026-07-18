# URDF Parquet Viewer

Minimal React Three Fiber viewer for URDF robots driven by Parquet frame data.

## Run

```bash
npm install
npm run dev
```

The app starts with the default assets in `public/assets/default`.

When a selected Parquet file contains a 40-value
`observation.joint_position` column, the viewer automatically selects the
built-in OpenArm + dual-XHand1 skeleton and maps values by the dataset's joint
order. This supports the `openarm_xhand1` LeRobot datasets without requiring a
separate URDF upload.

## Scripts

```bash
npm run build
npm run verify:fk
npm run verify:openarm
npm run generate:groups
```

`verify:fk` compares the viewer FK path against `fk_html_handoff` reference coordinates when that sibling directory is present.
