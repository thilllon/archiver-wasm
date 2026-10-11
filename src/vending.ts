/**
 * Archiver Vending
 *
 * @ignore
 * @license [MIT]{@link https://github.com/archiverjs/node-archiver/blob/master/LICENSE}
 * @copyright (c) 2012-2014 Chris Talkington, contributors.
 */
import Archiver from './core.js';
import Zip from './plugins/zip.js';
import Tar from './plugins/tar.js';
import Json from './plugins/json.js';
import type { ArchiverOptions, ModuleConstructor } from './types.js';

interface Vending {
  (format: string, options?: ArchiverOptions): Archiver;
  create(format: string, options?: ArchiverOptions): Archiver;
  registerFormat(format: string, module: ModuleConstructor): void;
  isRegisteredFormat(format: string): boolean;
}

var formats: Record<string, ModuleConstructor> = {};

/**
 * Dispenses a new Archiver instance.
 *
 * @constructor
 * @param  {String} format The archive format to use.
 * @param  {Object} options See [Archiver]{@link Archiver}
 * @return {Archiver}
 */
// archiver-zip-encrypted/node_modules/archiver/index.js:20-22
var vending: Vending = function(format: string, options?: ArchiverOptions) {
  return vending.create(format, options);
} as Vending;

/**
 * Creates a new Archiver instance.
 *
 * @param  {String} format The archive format to use.
 * @param  {Object} options See [Archiver]{@link Archiver}
 * @return {Archiver}
 */
// archiver-zip-encrypted/node_modules/archiver/index.js:31-41
vending.create = function(format: string, options?: ArchiverOptions) {
  if (formats[format]) {
    var instance = new Archiver(format, options);
    instance.setFormat(format);
    instance.setModule(new formats[format](options));

    return instance;
  } else {
    throw new Error('create(' + format + '): format not registered');
  }
};

/**
 * Registers a format for use with archiver.
 *
 * @param  {String} format The name of the format.
 * @param  {Function} module The function for archiver to interact with.
 * @return void
 */
// archiver-zip-encrypted/node_modules/archiver/index.js:50-64
vending.registerFormat = function(format: string, module: ModuleConstructor) {
  if (formats[format]) {
    throw new Error('register(' + format + '): format already registered');
  }

  if (typeof module !== 'function') {
    throw new Error('register(' + format + '): format module invalid');
  }

  if (typeof module.prototype.append !== 'function' || typeof module.prototype.finalize !== 'function') {
    throw new Error('register(' + format + '): format module missing methods');
  }

  formats[format] = module;
};

/**
 * Check if the format is already registered.
 * 
 * @param {String} format the name of the format.
 * @return boolean
 */
// archiver-zip-encrypted/node_modules/archiver/index.js:72-78
vending.isRegisteredFormat = function (format: string) {
  if (formats[format]) {
    return true;
  }
  
  return false;
};

vending.registerFormat('zip', Zip);
vending.registerFormat('tar', Tar);
vending.registerFormat('json', Json);

// archiver-zip-encrypted/node_modules/archiver/index.js:84 (module.exports = vending, PORTING.md 7.2)
export var create = vending.create;
export var registerFormat = vending.registerFormat;
export var isRegisteredFormat = vending.isRegisteredFormat;
export default vending;
