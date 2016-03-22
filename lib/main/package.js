'use strict';

/**
 * Package module for manipulating packages
 * @module Editor.Package
 */
let Package = {};
module.exports = Package;

// requires
const Electron = require('electron');
const NativeImage = require('native-image');
const Path = require('fire-path');
const Fs = require('fire-fs');
const Async = require('async');
const Semver = require('semver');
const _ = require('lodash');
const Console = require('./console');
const MainMenu = require('./main-menu');
const Ipc = require('./ipc');
const App = require('./app');
const i18n = require('./i18n');
const IpcListener = require('../share/ipc-listener');

//
let _lang = 'en';
let _versions = {};
let _path2package = {};
let _name2packagePath = {};
let _panel2info = {};
let _packageSearchPaths = [];

function _messageName ( packageName, messageName ) {
  if ( messageName.indexOf(':') === -1 ) {
    return `${packageName}:${messageName}`;
  }
  return messageName;
}

function _build ( packageObj, force, cb ) {
  if ( !packageObj.build ) {
    if ( cb ) {
      cb ( null, packageObj._path );
    }

    return;
  }

  if ( !force ) {
    // check if bin/dev exists
    let binPath = Path.join( packageObj._path, 'bin/dev' );
    if ( Fs.existsSync(binPath) ) {
      let packageJsonPath = Path.join( binPath, 'package.json');

      if (  Fs.existsSync(packageJsonPath)  ) {
        // check if bin/dev/package.json have the same version
        let binPackageObj = JSON.parse(Fs.readFileSync(packageJsonPath));

        if ( packageObj.version === binPackageObj.version ) {
          if ( cb ) {
            cb ( null, binPath );
          }

          return;
        }
      }
    }
  }

  Console.log( 'Building ' + packageObj.name );
  Package.build( packageObj._path, cb );
}

function _clearDependence(path, deps) {
  if ( !path ) {
    return;
  }

  let childDeps = [];
  deps.forEach(dep => {
    let file = dep.filename;
    // file: ./builtin/a/core/menu.js
    // path: ./builtin/a
    if ( file.indexOf(path) === 0 ) {
      // Internal file
      dep.children.forEach(item => {
        childDeps.push(item);
      });
      delete require.cache[file];
    }
  });

  if ( childDeps.length > 0 ) {
    _clearDependence( path, childDeps );
  }
}

/**
 * Load a package at path
 * @method load
 * @param {string} path - An absolute path point to a package folder
 * @param {object} [opts] - Options
 * @param {boolean} opts.build - Force rebuild the packages
 * @param {function} cb - Callback when finish loading
 */
Package.load = function ( path, opts, cb ) {
  opts = opts || {};

  if ( typeof opts === 'function' ) {
    cb = opts;
    opts = {};
  }

  if ( _path2package[path] ) {
    if ( cb ) cb ();
    return;
  }

  let packageJsonPath = Path.join( path, 'package.json' );
  let packageObj;
  try {
    packageObj = JSON.parse(Fs.readFileSync(packageJsonPath));
  } catch (err) {
    if ( cb ) {
      cb ( new Error( `Failed to load 'package.json': ${err.message}` ) );
    }
    return;
  }

  // check host, if we don't have the host, skip load it
  for ( let host in packageObj.hosts ) {
    let currentVer = _versions[host];
    if ( !currentVer ) {
      if ( cb ) {
        cb ( new Error( `Host '${host}' not exists.` ) );
      }
      return;
    }

    let requireVer = packageObj.hosts[host];
    if ( !Semver.satisfies( currentVer, requireVer ) ) {
      if ( cb ) {
        cb ( new Error( `Host '${host}' require ver ${requireVer}` ) );
      }
      return;
    }
  }

  //
  Async.series([
    next => {
      if ( !packageObj.pkgDependencies ) {
        next ();
        return;
      }

      Async.eachSeries(Object.keys(packageObj.pkgDependencies), (pkgName, done) => {
        let pkgPath = Package.find( pkgName );
        if ( !pkgPath ) {
          return done ( new Error(`Can not find dependencied package ${pkgName}`) );
        }

        Package.load( pkgPath, done );
      }, next);
    },

    next => {
      packageObj._path = path;
      _build ( packageObj, opts.build, ( err, destPath ) => {
        if ( err ) {
          next ( new Error( `Building failed: ${err.message}` ) );
          return;
        }

        packageObj._destPath = destPath;
        next ();
      });
    },

    next => {
      // register i18n from i18n/${lang}.js
      let i18nFile = Path.join( packageObj._destPath, 'i18n', `${_lang}.js` );
      if ( Fs.existsSync(i18nFile) ) {
        try {
          i18n.extend({
            [packageObj.name]: require(i18nFile),
          });
        } catch (e) {
          next ( new Error( `Failed to load ${i18nFile}: ${e.stack}` ) );
          return;
        }
      }

      let main = null;

      // load main.js
      // NOTE: it is possible for a package that does not have main-process code
      if ( packageObj.main ) {
        let mainPath = Path.join( packageObj._destPath, packageObj.main );
        try {
          main = require(mainPath);
        } catch (e) {
          next ( new Error( `Failed to load ${packageObj.main}: ${e.stack}` ) );
          return;
        }
      }

      // register main ipc messages
      if ( main ) {
        let ipcListener = new IpcListener();
        for ( let prop in main.messages ) {
          let fn = main.messages[prop];
          if ( typeof fn === 'function' ) {
            ipcListener.on( _messageName(packageObj.name,prop), fn.bind(main) );
          }
        }
        packageObj._ipc = ipcListener;
      }

      // register main-menu
      let mainMenuInfo = packageObj['main-menu'];
      if ( mainMenuInfo && typeof mainMenuInfo === 'object' ) {
        for ( let menuPath in mainMenuInfo ) {
          let fmtMenuPath = i18n.formatPath(menuPath);

          let parentMenuPath = Path.dirname(fmtMenuPath);
          if ( parentMenuPath === '.' ) {
            Console.failed(`Failed to add menu ${fmtMenuPath}`);
            continue;
          }

          let menuOpts = mainMenuInfo[menuPath];
          let template = _.assign({
            label: Path.basename(fmtMenuPath),
          }, menuOpts);

          // create NativeImage for icon
          if ( menuOpts.icon ) {
            let icon = NativeImage.createFromPath( Path.join(packageObj._destPath, menuOpts.icon) );
            template.icon = icon;
          }

          MainMenu.add( parentMenuPath, template );
        }
      }

      // register panel
      if ( packageObj.panels && typeof packageObj.panels === 'object' ) {
        for ( let panelName in packageObj.panels ) {
          let panelID = packageObj.name + '.' + panelName;
          if ( _panel2info[panelID] ) {
            Console.failed( `Failed to load panel "${panelName}" from "${packageObj.name}", already exists` );
            continue;
          }

          // setup default properties
          let panelInfo = packageObj.panels[panelName];
          _.defaults(panelInfo, {
            type: 'dockable',
            title: panelID,
            popable: true,
            messages: [],
            path: packageObj._destPath,
          });

          //
          _panel2info[panelID] = panelInfo;
        }
      }

      //
      _path2package[path] = packageObj;
      _name2packagePath[packageObj.name] = path;

      // invoke main.load
      if ( main && main.load ) {
        try {
          main.load();
        } catch (e) {
          Package.unload(path, () => {
            next ( new Error( `Failed to execute load() function: ${e.stack}` ) );
          });
          return;
        }
      }

      //
      Console.success( `${packageObj.name} loaded` );
      Ipc.sendToWindows('package:loaded', packageObj.name);
      next ();
    },

  ], cb);
};

/**
 * Unload a package at path
 * @method unload
 * @param {string} path - An absolute path point to a package folder
 * @param {function} cb - Callback when finish unloading
 */
Package.unload = function ( path, cb ) {
  let packageObj = _path2package[path];
  if ( !packageObj ) {
    if ( cb ) {
      cb ();
    }
    return;
  }

  // unregister i18n table
  i18n.unset([packageObj.name]);

  // unregister panel
  if ( packageObj.panels && typeof packageObj.panels === 'object' ) {
    for ( let panelName in packageObj.panels ) {
      let panelID = packageObj.name + '.' + panelName;
      delete _panel2info[panelID];
    }
  }

  // unregister main menu
  let mainMenuInfo = packageObj['main-menu'];
  if ( mainMenuInfo && typeof mainMenuInfo === 'object' ) {
    for ( let menuPath in mainMenuInfo ) {
      let fmtMenuPath = i18n.formatPath(menuPath);
      MainMenu.remove( fmtMenuPath );
    }
  }

  // unregister main ipc messages
  if ( packageObj._ipc ) {
    packageObj._ipc.clear();
  }

  // uncache main.js
  if ( packageObj.main ) {
    let cache = require.cache;
    let mainPath = Path.join( packageObj._destPath, packageObj.main );
    let cachedModule = cache[mainPath];

    // invoke main.unload()
    if ( cachedModule ) {
      let main = cachedModule.exports;
      if ( main && main.unload ) {
        try {
          main.unload();
        } catch (err) {
          Console.failed( `Failed to unload "${packageObj.main}" from "${packageObj.name}": ${err.stack}.` );
        }
      }

      _clearDependence( packageObj._destPath, cachedModule.children );
      delete cache[mainPath];
    } else {
      Console.failed( `Failed to uncache module ${packageObj.main}: Can not find it.` );
    }
  }

  //
  delete _path2package[path];
  delete _name2packagePath[packageObj.name];
  Console.success( `${packageObj.name} unloaded` );
  Ipc.sendToWindows('package:unloaded', packageObj.name);

  if ( cb ) {
    cb ();
  }
};

/**
 * Reload a package at path
 * @method reload
 * @param {string} path - An absolute path point to a package folder
 * @param {object} opts - Options
 * @param {Boolean} opts.rebuild - If rebuild the project
 * @param {function} cb - Callback when finish reloading
 */
Package.reload = function ( path, opts, cb ) {
  opts = opts || {};
  let rebuild = (typeof opts.rebuild === 'boolean') ? opts.rebuild : true;

  Async.series([
    next => {
      let packageObj = _path2package[path];
      if ( !packageObj ) {
        next ();
        return;
      }

      if ( rebuild && packageObj.build ) {
        Console.log( 'Rebuilding ' + packageObj.name );
        Package.build( path, next );
        return;
      }

      next ();
    },

    next => {
      Package.unload(path, next);
    },

    next => {
      Package.load(path, next);
    },
  ], err => {
    if (cb) {
      cb ( err );
    }
  });
};

/**
 * Find and get panel info via panelID, the panel info is the json object
 * that defined in `panels.{panel-name}` in your package.json
 * @method panelInfo
 * @param {string} panelID
 * @return {object}
 */
Package.panelInfo = function ( panelID ) {
  return _panel2info[panelID];
};

/**
 * Find and get package info via path, the package info is the json object of your package.json file
 * @method packageInfo
 * @param {string} path - The path can be any files in this package
 * @return {object}
 */
Package.packageInfo = function ( path ) {
  for ( var p in _path2package ) {
    if ( Path.contains( p, path )  ) {
      return _path2package[p];
    }
  }
  return null;
};

/**
 * Return the path of the package by name
 * @method packagePath
 * @param {string} packageName
 * @return {string}
 */
Package.packagePath = function ( packageName ) {
  return _name2packagePath[packageName];
};

/**
 * Build package at path
 * @method build
 * @param {string} path
 * @param {function} callback
 * @return {string}
 */
Package.build = function ( path, cb ) {
  const BuildPackage = require('./build-package');
  BuildPackage.start({
    path: path,
    minify: false,
    babel: false,
  }, err => {
    if ( err ) {
      Console.error(`Failed to build package at ${path}, ${err.message}`);
      if ( cb ) cb ( err );
      return;
    }

    if ( cb ) cb ( null, Path.join(path, 'bin/dev') );
  });
};

/**
 * Add package search path
 * @method addPath
 * @param {string|array} path
 */
Package.addPath = function ( path ) {
  if ( !Array.isArray(path) ) {
    path = [path];
  }

  _packageSearchPaths = _.union( _packageSearchPaths, path );
};

/**
 * Remove search path from package search path list
 * @method removePath
 * @param {string} path
 */
Package.removePath = function ( path ) {
  let idx = _packageSearchPaths.indexOf(path);
  if ( idx !== -1 ) {
    _packageSearchPaths.splice(idx,1);
  }
};

/**
 * Reset path
 * @method resetPath
 */
Package.resetPath = function () {
  _packageSearchPaths = [];
};

/**
 * Find package by name in package search path list
 * @method find
 * @param {string} name - package name
 * @return {string} - package path
 */
Package.find = function ( name ) {
  for ( let i = 0; i < _packageSearchPaths.length; ++i ) {
    let searchPath = _packageSearchPaths[i];
    if ( Fs.isDirSync(searchPath) ) {
      let list = Fs.readdirSync( searchPath );
      if ( list.indexOf(name) !== -1 ) {
        return Path.join( searchPath, name );
      }
    }
  }

  return null;
};

/**
 * Return package search path list
 * @property {array} paths
 */
Object.defineProperty(Package, 'paths', {
  enumerable: true,
  get() {
    return _packageSearchPaths.slice();
  }
});

/**
 * Return package search path list
 * @property {array} paths
 */
Object.defineProperty(Package, 'lang', {
  enumerable: true,
  set(value) {
    _lang = value;
  },
  get() {
    return _lang;
  }
});

/**
 * Return package search path list
 * @property {array} paths
 */
Object.defineProperty(Package, 'versions', {
  enumerable: true,
  set(value) {
    _versions = value;
  },
  get() {
    return _versions;
  }
});

// ========================================
// Ipc
// ========================================

const ipcMain = Electron.ipcMain;

ipcMain.on('package:query-infos', (event, reply) => {
  let builtinPath = Path.join( App.path, 'builtin' );
  let results = [];

  for ( let path in _path2package ) {
    results.push({
      path: path,
      builtin: Path.contains( builtinPath, path ),
      enabled: true, // TODO:
      info: _path2package[path],
    });
  }

  reply(results);
});

ipcMain.on('package:query-info', (event, reply, name) => {
  let path = _name2packagePath[name];
  path = path ? path : '';

  let info = _path2package[path];
  let builtinPath = Path.join( App.path, 'builtin' );

  reply({
    path: path,
    builtin: Path.contains( builtinPath, path ),
    enabled: true, // TODO:
    info: info,
  });
});

ipcMain.on('package:reload', (event, name) => {
  let path = _name2packagePath[name];
  if ( !path ) {
    Console.error(`Failed to reload package ${name}, not found`);
    return;
  }

  Package.reload(path);
});