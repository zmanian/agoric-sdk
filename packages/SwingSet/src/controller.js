/* global Compartment harden */

import fs from 'fs';
import path from 'path';
import re2 from 're2';
import { assert } from '@agoric/assert';

import { isTamed, tameMetering } from '@agoric/tame-metering';
import bundleSource from '@agoric/bundle-source';
import { importBundle } from '@agoric/import-bundle';
import { initSwingStore } from '@agoric/swing-store-simple';
import { HandledPromise } from '@agoric/eventual-send';

import { makeMeteringTransformer } from '@agoric/transform-metering';
import * as babelCore from '@babel/core';
import { makeTransform } from '@agoric/transform-eventual-send';
import * as babelParser from '@agoric/babel-parser';
import babelGenerate from '@babel/generator';

import anylogger from 'anylogger';

import { waitUntilQuiescent } from './waitUntilQuiescent';
import { insistStorageAPI } from './storageAPI';
import { insistCapData } from './capdata';
import { parseVatSlot } from './parseVatSlots';

const log = anylogger('SwingSet:controller');

// FIXME: Put this somewhere better.
process.on('unhandledRejection', e =>
  log.error('UnhandledPromiseRejectionWarning:', e),
);

const ADMIN_DEVICE_PATH = require.resolve('./kernel/vatAdmin/vatAdmin-src');
const ADMIN_VAT_PATH = require.resolve('./kernel/vatAdmin/vatAdminWrapper');
const KERNEL_SOURCE_PATH = require.resolve('./kernel/kernel.js');

function byName(a, b) {
  if (a.name < b.name) {
    return -1;
  }
  if (a.name > b.name) {
    return 1;
  }
  return 0;
}

/**
 * Scan a directory for files defining the vats to bootstrap for a swingset.
 * Looks for files with names of the pattern `vat-NAME.js` as well as a file
 * named 'bootstrap.js'.
 *
 * @param basedir  The directory to scan
 *
 * @return an object {
 *    vats, // map from NAME to the full path to the corresponding .js file
 *    bootstrapIndexJS, // path to the bootstrap.js file, or undefined if none
 * }
 *
 * TODO: bootstrapIndexJS is a terrible name.  Rename to something like
 * bootstrapSourcePath (renaming mildly complicated because it's referenced in
 * lots of places).
 */
export function loadBasedir(basedir) {
  log.debug(`= loading config from basedir ${basedir}`);
  const vats = new Map(); // name -> { sourcepath, options }
  const subs = fs.readdirSync(basedir, { withFileTypes: true });
  subs.sort(byName);
  subs.forEach(dirent => {
    if (dirent.name.endsWith('~')) {
      // Special case crap filter to ignore emacs backup files and the like.
      // Note that the regular filename parsing below will ignore such files
      // anyway, but this skips logging them so as to reduce log spam.
      return;
    }
    if (
      dirent.name.startsWith('vat-') &&
      dirent.isFile() &&
      dirent.name.endsWith('.js')
    ) {
      const name = dirent.name.slice('vat-'.length, -'.js'.length);
      const vatSourcePath = path.resolve(basedir, dirent.name);
      vats.set(name, { sourcepath: vatSourcePath, options: {} });
    } else {
      log.debug('ignoring ', dirent.name);
    }
  });
  let bootstrapIndexJS = path.resolve(basedir, 'bootstrap.js');
  try {
    fs.statSync(bootstrapIndexJS);
  } catch (e) {
    // TODO this will catch the case of the file not existing but doesn't check
    // that it's a plain file and not a directory or something else unreadable.
    // Consider putting in a more sophisticated check if this whole directory
    // scanning thing is something we decide we want to have long term.
    bootstrapIndexJS = undefined;
  }
  return { vats, bootstrapIndexJS };
}

export async function buildVatController(config, argv = []) {
  if (typeof Compartment === 'undefined') {
    throw Error('SES must be installed before calling buildVatController');
  }
  // todo: move argv into the config

  // https://github.com/Agoric/SES-shim/issues/292
  harden(Object.getPrototypeOf(console));
  harden(console);

  function kernelRequire(what) {
    if (what === '@agoric/harden') {
      return harden;
    } else if (what === 're2') {
      // The kernel imports @agoric/transform-metering to get makeMeter(),
      // and transform-metering imports re2, to add it to the generated
      // endowments. TODO Our transformers no longer traffic in endowments,
      // so that could probably be removed, in which case we'd no longer need
      // to provide it here. We should decide whether to let the kernel use
      // the native RegExp or replace it with re2. TODO we also need to make
      // sure vats get (and stick with) re2 for their 'RegExp'.
      return re2;
    } else {
      throw Error(`kernelRequire unprepared to satisfy require(${what})`);
    }
  }
  const kernelSource = await bundleSource(KERNEL_SOURCE_PATH);
  const kernelNS = await importBundle(kernelSource, {
    filePrefix: 'kernel',
    endowments: {
      console,
      require: kernelRequire,
      HandledPromise,
    },
  });
  const buildKernel = kernelNS.default;

  // transformMetering() requires Babel, which imports 'fs' and 'path', so it
  // cannot be implemented within a non-start-Compartment. We build it out
  // here and pass it to the kernel, which then passes it to vats. This is
  // intended to be powerless. TODO: when we remove metering within vats
  // (leaving only vat-at-a-time metering), this function should only be used
  // to build loadStaticVat and loadDynamicVat. It may still be passed to the
  // kernel (for loadDynamicVat), but it should no longer be passed into the
  // vats themselves. TODO: transformMetering() is sync because it is passed
  // into c.evaluate (which of course cannot handle async), but in the
  // future, this may live on the far side of a kernel/vatworker boundary, so
  // we kind of want it to be async.
  const mt = makeMeteringTransformer(babelCore);
  function transformMetering(src, getMeter) {
    // 'getMeter' provides the meter to which the transformation itself is
    // billed (the COMPUTE meter is charged the length of the source string).
    // The endowment must be present and truthy, otherwise the transformation
    // is disabled. TODO: rethink that, and have @agoric/transform-metering
    // export a simpler function (without 'endowments' or .rewrite).
    const ss = mt.rewrite({ src, endowments: { getMeter } });
    return ss.src;
  }
  harden(transformMetering);

  // the same is true for the tildot transform
  const transformTildot = harden(makeTransform(babelParser, babelGenerate));

  // Allow vats to import certain modules, by providing them the same values
  // we imported here in the kernel, which came themselves from
  // kernelRequire() defined in the controller. This will go away once
  // 'harden' is used as a global everywhere, and vats no longer need to
  // import anything outside their bundle.

  function vatRequire(what) {
    throw Error(`vatRequire unprepared to satisfy require(${what})`);
  }

  const vatEndowments = harden({
    console,
    require: vatRequire,
    HandledPromise,
    // re2 is a RegExp work-a-like that disables backtracking expressions for
    // safer memory consumption
    RegExp: re2,
  });

  async function loadStaticVat(sourceIndex, name) {
    if (!(sourceIndex[0] === '.' || path.isAbsolute(sourceIndex))) {
      throw Error(
        'sourceIndex must be relative (./foo) or absolute (/foo) not bare (foo)',
      );
    }
    const bundle = await bundleSource(sourceIndex);
    const vatNS = await importBundle(bundle, {
      filePrefix: name,
      endowments: vatEndowments,
    });
    let setup;
    if ('buildRootObject' in vatNS) {
      setup = (syscall, state, helpers, vatPowers) => {
        return helpers.makeLiveSlots(
          syscall,
          state,
          (_E, _D, vatP) => vatNS.buildRootObject(vatP),
          helpers.vatID,
          vatPowers,
        );
      };
    } else {
      setup = vatNS.default;
    }
    return setup;
  }

  const hostStorage = config.hostStorage || initSwingStore().storage;
  insistStorageAPI(hostStorage);

  // It is important that tameMetering() was called by application startup,
  // before install-ses. Rather than ask applications to capture the return
  // value and pass it all the way through to here, we just run
  // tameMetering() again (and rely upon its only-once behavior) to get the
  // control facet (replaceGlobalMeter), and pass it in through
  // kernelEndowments. If our enclosing application decided to not tame the
  // globals, we detect that and refrain from touching it later.
  const replaceGlobalMeter = isTamed() ? tameMetering() : undefined;
  console.log(
    `SwingSet global metering is ${
      isTamed() ? 'enabled' : 'disabled (no replaceGlobalMeter)'
    }`,
  );

  // we give the kernel a meteringTransform function, so it can offer it to

  const kernelEndowments = {
    waitUntilQuiescent,
    hostStorage,
    vatEndowments,
    vatAdminDevSetup: await loadStaticVat(ADMIN_DEVICE_PATH, 'dev-vatAdmin'),
    vatAdminVatSetup: await loadStaticVat(ADMIN_VAT_PATH, 'vat-vatAdmin'),
    replaceGlobalMeter,
    transformMetering,
    transformTildot,
  };

  const kernel = buildKernel(kernelEndowments);

  if (config.verbose) {
    kernel.kdebugEnable(true);
  }

  async function addGenesisVat(name, sourceIndex, options = {}) {
    log.debug(`= adding vat '${name}' from ${sourceIndex}`);
    const setup = await loadStaticVat(sourceIndex, `vat-${name}`);
    kernel.addGenesisVat(name, setup, options);
  }

  async function addGenesisDevice(name, sourceIndex, endowments) {
    const setup = await loadStaticVat(sourceIndex, `dev-${name}`);
    kernel.addGenesisDevice(name, setup, endowments);
  }

  if (config.devices) {
    for (const [name, srcpath, endowments] of config.devices) {
      // eslint-disable-next-line no-await-in-loop
      await addGenesisDevice(name, srcpath, endowments);
    }
  }

  if (config.vats) {
    for (const name of config.vats.keys()) {
      const v = config.vats.get(name);
      // eslint-disable-next-line no-await-in-loop
      await addGenesisVat(name, v.sourcepath, v.options || {});
    }
  }

  let bootstrapVatName;
  if (config.bootstrapIndexJS) {
    bootstrapVatName = '_bootstrap';
    await addGenesisVat(bootstrapVatName, config.bootstrapIndexJS, {});
  }

  // start() may queue bootstrap if state doesn't say we did it already. It
  // also replays the transcripts from a previous run, if any, which will
  // execute vat code (but all syscalls will be disabled)
  const bootstrapResult = await kernel.start(
    bootstrapVatName,
    JSON.stringify(argv),
  );

  // the kernel won't leak our objects into the Vats, we must do
  // the same in this wrapper
  const controller = harden({
    log(str) {
      kernel.log(str);
    },

    dump() {
      return JSON.parse(JSON.stringify(kernel.dump()));
    },

    verboseDebugMode(flag) {
      kernel.kdebugEnable(flag);
    },

    async run() {
      return kernel.run();
    },

    async step() {
      return kernel.step();
    },

    getStats() {
      return JSON.parse(JSON.stringify(kernel.getStats()));
    },

    // these are for tests

    vatNameToID(vatName) {
      return kernel.vatNameToID(vatName);
    },
    deviceNameToID(deviceName) {
      return kernel.deviceNameToID(deviceName);
    },

    queueToVatExport(vatName, exportID, method, args, resultPolicy = 'ignore') {
      const vatID = kernel.vatNameToID(vatName);
      parseVatSlot(exportID);
      assert.typeof(method, 'string');
      insistCapData(args);
      kernel.addExport(vatID, exportID);
      return kernel.queueToExport(vatID, exportID, method, args, resultPolicy);
    },

    bootstrapResult,
  });

  return controller;
}
