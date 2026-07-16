// WITH_GENESYS
// Ensures published addons resolve this package's own Three.js version instead of
// a package-manager-hoisted `three` alias from another engine version.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const packageRoot = path.resolve( process.argv[ 2 ] ?? process.cwd() );
const addonsRoot = path.join( packageRoot, 'examples', 'jsm' );
const packageJson = JSON.parse( await readFile( path.join( packageRoot, 'package.json' ), 'utf8' ) );
const packageName = packageJson.name;

if ( packageName !== '@gnsx/three' ) {

	throw new Error( `Expected package name "@gnsx/three", received "${ packageName }".` );

}

const importFromPattern = /^(\s*(?:(?:import|export)\b.*?\bfrom\s*|}\s*from\s*))(['"])three(?=\/|\2)([^'"]*)\2/gm;
const sideEffectImportPattern = /^(\s*import\s*)(['"])three(?=\/|\2)([^'"]*)\2/gm;

let changedFileCount = 0;
let rewrittenImportCount = 0;

for ( const filePath of await collectJavaScriptFiles( addonsRoot ) ) {

	const source = await readFile( filePath, 'utf8' );
	let fileRewriteCount = 0;
	const rewriteSpecifier = ( match, prefix, quote, suffix ) => {

		fileRewriteCount ++;

		return `${ prefix }${ quote }${ packageName }${ suffix }${ quote }`;

	};

	const transformed = source
		.replace( importFromPattern, rewriteSpecifier )
		.replace( sideEffectImportPattern, rewriteSpecifier );

	if ( fileRewriteCount > 0 ) {

		await writeFile( filePath, transformed );
		changedFileCount ++;
		rewrittenImportCount += fileRewriteCount;

	}

}

if ( rewrittenImportCount === 0 ) {

	throw new Error( `No addon imports were rewritten under ${ addonsRoot }.` );

}

console.log( `Rewrote ${ rewrittenImportCount } Three.js addon imports across ${ changedFileCount } files.` );

async function collectJavaScriptFiles( directory ) {

	const entries = await readdir( directory, { withFileTypes: true } );
	const files = [];

	for ( const entry of entries ) {

		const entryPath = path.join( directory, entry.name );
		if ( entry.isDirectory() ) {

			files.push( ...await collectJavaScriptFiles( entryPath ) );

		} else if ( entry.isFile() && entry.name.endsWith( '.js' ) ) {

			files.push( entryPath );

		}

	}

	return files;

}

// !WITH_GENESYS
