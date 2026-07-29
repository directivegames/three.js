// WITH_GENESYS
/**
 * Shared deterministic PRNG helpers (FNV-1a seed hash + xorshift32).
 * Used by sibling-local nodeId allocation and other deterministic streams.
 */

/**
 * Lightweight FNV-1a hash for converting strings into a deterministic 32-bit seed.
 * @param {string} input
 * @return {number}
 */
function hashStringToUint32( input ) {

	let hash = 0x811c9dc5;

	for ( let i = 0; i < input.length; i ++ ) {

		hash ^= input.charCodeAt( i );
		hash = Math.imul( hash, 0x01000193 );

	}

	return ( hash >>> 0 ) || 0x9e3779b9;

}

/**
 * Xorshift32 step; deterministic and fast for ID generation. Never returns 0.
 * @param {number} state
 * @return {number}
 */
function xorshift32( state ) {

	let next = state | 0;
	next ^= next << 13;
	next ^= next >>> 17;
	next ^= next << 5;
	return ( next >>> 0 ) || 0x9e3779b9;

}

/**
 * Random non-zero uint32 seed for non-deterministic streams.
 * @return {number}
 */
function randomSeedUint32() {

	return ( ( Math.random() * 0x100000000 ) >>> 0 ) || 0x9e3779b9;

}

/**
 * Deterministic xorshift32 stream. Internal state is never 0.
 */
class XorShift32 {

	/**
	 * @param {number|string} [seed]
	 */
	constructor( seed = randomSeedUint32() ) {

		this._state = typeof seed === 'string'
			? hashStringToUint32( seed )
			: ( ( seed >>> 0 ) || 0x9e3779b9 );

	}

	/**
	 * Advance and return the next non-zero uint32.
	 * @return {number}
	 */
	nextUint32() {

		this._state = xorshift32( this._state );
		return this._state;

	}

	/**
	 * Advance and return the low 16 bits (0 is allowed).
	 * @return {number}
	 */
	nextUint16() {

		return this.nextUint32() & 0xffff;

	}

	/**
	 * @return {number}
	 */
	getState() {

		return this._state >>> 0;

	}

	/**
	 * @param {number} state
	 */
	setState( state ) {

		this._state = ( state >>> 0 ) || 0x9e3779b9;

	}

	/**
	 * @return {XorShift32}
	 */
	clone() {

		return new XorShift32( this._state );

	}

}

export { hashStringToUint32, xorshift32, randomSeedUint32, XorShift32 };
// !WITH_GENESYS
