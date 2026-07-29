// WITH_GENESYS
/**
 * Sibling-local 16-bit node identities.
 *
 * `null` / `undefined` mean unset. `0` is a valid NodeId.
 */

import { hashStringToUint32, randomSeedUint32, XorShift32 } from '../math/XorShift32.js';

/**
 * True when `id` is a finite integer in the uint16 range (including 0).
 * @param {unknown} id
 * @return {boolean}
 */
function isValidNodeId( id ) {

	return typeof id === 'number' && Number.isInteger( id ) && id >= 0 && id <= 0xffff;

}

/**
 * Canonical display form: 4 lowercase hex characters.
 * @param {number} id
 * @return {string}
 */
function nodeIdToString( id ) {

	return ( id & 0xffff ).toString( 16 ).padStart( 4, '0' );

}

/**
 * Parses a hex node-id segment (1–4 hex digits).
 * @param {string} value
 * @return {?number}
 */
function nodeIdFromString( value ) {

	const trimmed = value.trim();
	if ( ! /^[0-9a-fA-F]{1,4}$/.test( trimmed ) ) {

		return null;

	}

	return Number.parseInt( trimmed, 16 ) & 0xffff;

}

const defaultNodeIdRng = new XorShift32();

/**
 * Seeds the process-wide NodeId RNG for deterministic construction.
 * Pass `undefined` / omit to restore a non-deterministic stream.
 * @param {string} [seed]
 */
function configureNodeIdSeed( seed ) {

	if ( seed == null ) {

		defaultNodeIdRng.setState( randomSeedUint32() );
		return;

	}

	defaultNodeIdRng.setState( hashStringToUint32( seed ) );

}

/**
 * Generates a random NodeId from the process-wide default RNG.
 * @param {XorShift32} [rng]
 * @return {number}
 */
function generateNodeId( rng = defaultNodeIdRng ) {

	return rng.nextUint16();

}

/**
 * Allocates a NodeId not present in `existing`.
 * @param {Iterable<number>|ReadonlySet<number>} existing
 * @param {XorShift32} [rng]
 * @return {number}
 */
function allocateNodeId( existing, rng = defaultNodeIdRng ) {

	const taken = existing instanceof Set ? existing : new Set( existing );
	if ( taken.size >= 0x10000 ) {

		throw new Error( '[nodeId] Cannot allocate NodeId: all 65536 sibling ids are in use' );

	}

	let id = rng.nextUint16();
	while ( taken.has( id ) ) {

		id = rng.nextUint16();

	}

	return id;

}

/**
 * Deterministic NodeId from a stable key (first-try candidate for remints).
 * @param {string} key
 * @return {number}
 */
function nodeIdFromKey( key ) {

	return new XorShift32( key ).nextUint16();

}

/**
 * Collects nodeId values from a sibling set.
 * @param {Iterable<{nodeId?: ?number}>} nodes
 * @param {Object} [except]
 * @return {Set<number>}
 */
function collectSiblingNodeIds( nodes, except ) {

	const taken = new Set();
	for ( const node of nodes ) {

		if ( node !== except && isValidNodeId( node.nodeId ) ) {

			taken.add( node.nodeId );

		}

	}

	return taken;

}

/**
 * Ensures `object.nodeId` is unique among `parent.children`.
 * @param {import('./Object3D.js').Object3D} object
 * @param {import('./Object3D.js').Object3D} parent
 */
function ensureUniqueNodeIdAmongParentChildren( object, parent ) {

	const taken = collectSiblingNodeIds( parent.children, object );
	if ( ! isValidNodeId( object.nodeId ) || taken.has( object.nodeId ) ) {

		object.nodeId = allocateNodeId( taken );

	}

}

export {
	isValidNodeId,
	nodeIdToString,
	nodeIdFromString,
	configureNodeIdSeed,
	generateNodeId,
	allocateNodeId,
	nodeIdFromKey,
	collectSiblingNodeIds,
	ensureUniqueNodeIdAmongParentChildren
};
// !WITH_GENESYS
