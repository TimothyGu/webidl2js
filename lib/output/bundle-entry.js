"use strict";

const allExports = {};
binding.exports = allExports;
binding.bootstrap = function (globalInterface) {
  for (const name of Object.keys(allExports)) {
    const obj = allExports[name];
    if (typeof obj.expose[globalInterface] === "object") {
      for (const exposed of Object.keys(obj.expose[globalInterface])) {
        Object.defineProperty(global, exposed, {
          writable: true,
          enumerable: false,
          configurable: true,
          value: obj.expose[globalInterface][exposed]
        });
      }
    }
  }
};

// Below this line, exports will be added.
