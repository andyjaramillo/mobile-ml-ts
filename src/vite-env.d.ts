/// <reference types="vite/client" />

// vite/client's own asset-module declarations don't include apng (only the common
// raster/vector types) — TestGaitCamera.tsx imports the gait alignment overlay as a
// url-returning module the same way, so it needs its own declaration.
declare module "*.apng" {
	const src: string;
	export default src;
}
