// WITH_GENESYS
// Genesys: stable GPU texture names for perf.snapshot / VRAM tooling.

/**
 * @param {import('../core/RenderTarget.js').RenderTarget} renderTarget
 * @param {string} baseName
 * @param {string} [attachmentName='color']
 */
function labelColorTextures( renderTarget, baseName, attachmentName = 'color' ) {

	const textures = renderTarget.textures;

	for ( let i = 0; i < textures.length; i ++ ) {

		const texture = textures[ i ];

		if ( textures.length === 1 ) {

			texture.name = `${ baseName }.${ attachmentName }`;

		} else {

			texture.name = `${ baseName }.${ attachmentName }${ i }`;

		}

	}

}

/**
 * Assigns `renderTarget.name` and names color / depth attachments for GPU memory reports.
 *
 * @param {import('../core/RenderTarget.js').RenderTarget} renderTarget
 * @param {string} baseName
 * @param {Object} [options]
 * @param {string} [options.colorAttachment='color']
 * @param {string} [options.depthAttachment='depth']
 */
export function labelRenderTargetTextures( renderTarget, baseName, options = {} ) {

	const { colorAttachment = 'color', depthAttachment = 'depth' } = options;

	renderTarget.name = baseName;
	labelColorTextures( renderTarget, baseName, colorAttachment );

	if ( renderTarget.depthTexture !== null && renderTarget.depthTexture !== undefined ) {

		renderTarget.depthTexture.name = `${ baseName }.${ depthAttachment }`;

	}

}

/**
 * @param {string} passName
 * @param {string} attachment
 * @return {string}
 */
export function passAttachmentTextureName( passName, attachment ) {

	const base = passName || 'Pass';

	return `${ base }.${ attachment }`;

}

/**
 * Names a depth attachment for GPU memory reports. Reuses the primary depth
 * texture's name when the renderer allocates mips or replacement buffers.
 *
 * @param {import('../core/RenderTarget.js').RenderTarget} renderTarget
 * @param {import('../textures/DepthTexture.js').DepthTexture} depthTexture
 * @param {number} [mipLevel=0]
 */
export function labelDepthTextureForRenderTarget( renderTarget, depthTexture, mipLevel = 0 ) {

	if ( depthTexture === null || depthTexture === undefined ) {

		return;

	}

	const primary = renderTarget.depthTexture;

	if ( primary && primary !== depthTexture && primary.name !== '' ) {

		depthTexture.name = mipLevel === 0 ? primary.name : `${ primary.name }.mip${ mipLevel }`;
		return;

	}

	const rtName = renderTarget.name || 'RenderTarget';
	const suffix = mipLevel === 0 ? 'depth' : `depth.mip${ mipLevel }`;

	depthTexture.name = `${ rtName }.${ suffix }`;

}

// !WITH_GENESYS
