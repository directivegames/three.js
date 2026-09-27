// WITH_GENESYS
// Wireframe debug view. Scene meshes are drawn as lines. Lighting is unchanged.
// !WITH_GENESYS

/**
 * Wireframe. Each scene mesh is drawn as lines along its triangle edges.
 * Lighting, color, and tone mapping stay the same as the shaded view.
 * Shadow passes and fullscreen quads stay triangles.
 *
 * @type {string}
 */
export const DEBUG_VIEW_WIREFRAME = 'wireframe';

/**
 * Whether the wireframe debug view should take over this draw.
 * Shadow passes stay triangles so shadows still cover the surface. Fullscreen quads stay
 * triangles so post-processing still fills the screen. A material with `allowOverride`
 * false (the renderer skybox) stays shaded behind the edges.
 *
 * @param {Material} material - The material being drawn.
 * @param {?Renderer} renderer - The renderer. May be null.
 * @param {?Object3D} [object=null] - The object being drawn.
 * @return {boolean} `true` when the debug view forces a wireframe.
 */
export function debugViewForcesWireframe( material, renderer, object = null ) {

	const debug = renderer !== null && renderer !== undefined ? renderer.debug : undefined;

	if ( debug === undefined || debug.view !== DEBUG_VIEW_WIREFRAME ) return false;

	if ( material.isShadowPassMaterial === true ) return false;

	if ( material.allowOverride === false ) return false;

	// Lines and points already draw as lines. Rewriting their index as triangle edges
	// would skip vertices. Quad meshes are fullscreen passes.
	if ( object === null || object === undefined || object.isMesh !== true || object.isQuadMesh === true ) return false;

	return true;

}

/**
 * Whether this draw should use line topology.
 * A material that already sets `wireframe` stays a wireframe in every view.
 * The wireframe debug view forces it for scene meshes. A renderer without `debug`
 * (the legacy WebGL renderer) only honors the material flag.
 *
 * @param {Material} material - The material being drawn.
 * @param {?Renderer} renderer - The renderer. May be null.
 * @param {?Object3D} [object=null] - The object being drawn.
 * @return {boolean} `true` when the draw is lines.
 */
export function materialDrawsWireframe( material, renderer, object = null ) {

	if ( material.wireframe === true ) return true;

	return debugViewForcesWireframe( material, renderer, object );

}
