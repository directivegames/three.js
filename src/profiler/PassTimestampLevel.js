// WITH_GENESYS
/**
 * Detail levels for GPU timestamps written inside passes (see `Backend.beginPassTimestampSpan()`).
 *
 * @type {{OFF: number, STAGE: number, DRAW: number}}
 */
export const PassTimestampLevel = Object.freeze( {
	OFF: 0,
	STAGE: 1,
	DRAW: 2
} );
// !WITH_GENESYS
