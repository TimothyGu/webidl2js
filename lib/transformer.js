"use strict";

const path = require("path");

const co = require("co");
const fs = require("pn/fs");
const webidl = require("webidl2");
const prettier = require("prettier");

const Context = require("./context");
const Typedef = require("./constructs/typedef");
const Interface = require("./constructs/interface");
const Dictionary = require("./constructs/dictionary");

class Transformer {
  constructor(opts = {}) {
    this.ctx = new Context({
      implSuffix: opts.implSuffix
    });
    this.options = Object.assign({
      suppressErrors: false
    }, opts);

    this.sources = [];
    this.modules = new Map();
  }

  addSource(idl, impl) {
    if (typeof idl !== "string") {
      throw new TypeError("idl path has to be a string");
    }
    if (typeof impl !== "string") {
      throw new TypeError("impl path has to be a string");
    }
    this.sources.push({ idlPath: idl, impl });
    return this;
  }

  addModule(moduleName, packageJSONPath = require.resolve(path.posix.join(moduleName, "package.json"))) {
    if (typeof moduleName !== "string") {
      throw new TypeError("module name has to be a string");
    }
    if (typeof packageJSONPath !== "string") {
      throw new TypeError("package.json path has to be a string");
    }
    this.modules.set(moduleName, packageJSONPath);
    return this;
  }

  * _collectSources() {
    const files = [];
    const promises = [];

    for (const src of this.sources) {
      promises.push(co(function* () {
        const stat = yield fs.stat(src.idlPath);
        if (stat.isDirectory()) {
          const folderContents = yield fs.readdir(src.idlPath);
          for (const file of folderContents) {
            if (file.endsWith(".idl")) {
              files.push({
                idlPath: path.join(src.idlPath, file),
                impl: src.impl
              });
            }
          }
        } else {
          files.push({
            idlPath: src.idlPath,
            impl: src.impl
          });
        }
      }));
    }

    for (const [modName, packageJSON] of this.modules) {
      promises.push(co(function* () {
        const pkg = JSON.parse(yield fs.readFile(packageJSON));
        if (!pkg.webidl2js) {
          return;
        }
        const modPath = path.dirname(packageJSON);
        const genPath = path.posix.join(modName, pkg.webidl2js.interface);
        for (const file of pkg.webidl2js.idl) {
          files.push({
            idlPath: path.resolve(modPath, file),
            genPath
          });
        }
      }));
    }

    yield Promise.all(promises);
    return files;
  }

  * _readFiles(files) {
    const zipped = [];
    const fileContents = yield Promise.all(files.map(f => fs.readFile(f.idlPath, { encoding: "utf-8" })));
    for (let i = 0; i < files.length; ++i) {
      zipped.push({
        idlContent: fileContents[i],
        impl: files[i].impl,
        genPath: files[i].genPath
      });
    }
    return zipped;
  }

  _parse(outputDir, contents) {
    const parsed = contents.map(content => ({
      idl: webidl.parse(content.idlContent),
      impl: content.impl,
      genPath: content.genPath
    }));

    const { interfaces, dictionaries, typedefs, customTypes } = this.ctx;

    // first we're gathering all full interfaces and ignore partial ones
    for (const file of parsed) {
      for (const instruction of file.idl) {
        let obj;
        switch (instruction.type) {
          case "interface":
            if (instruction.partial) {
              break;
            }

            obj = new Interface(this.ctx, instruction, {
              implDir: file.impl && path.resolve(outputDir, file.impl),
              path: file.genPath && path.join(file.genPath, `${instruction.name}.js`)
            });
            interfaces.set(obj.name, obj);
            customTypes.set(obj.name, "interface");
            break;
          case "implements":
            break; // handled later
          case "dictionary":
            if (instruction.partial) {
              break;
            }

            obj = new Dictionary(this.ctx, instruction, {
              path: file.genPath && path.join(file.genPath, `${instruction.name}.js`)
            });
            dictionaries.set(obj.name, obj);
            customTypes.set(obj.name, "dictionary");
            break;
          case "typedef":
            obj = new Typedef(this.ctx, instruction);
            typedefs.set(obj.name, obj);
            break;
          default:
            if (!this.options.suppressErrors) {
              throw new Error("Can't convert type '" + instruction.type + "'");
            }
        }
      }
    }

    // second we add all partial members and handle implements
    for (const file of parsed) {
      for (const instruction of file.idl) {
        let oldMembers;
        let extAttrs;
        switch (instruction.type) {
          case "interface":
            if (!instruction.partial) {
              break;
            }

            if (this.options.suppressErrors && !interfaces.has(instruction.name)) {
              break;
            }
            oldMembers = interfaces.get(instruction.name).idl.members;
            oldMembers.push(...instruction.members);
            extAttrs = interfaces.get(instruction.name).idl.extAttrs;
            extAttrs.push(...instruction.extAttrs);
            break;
          case "dictionary":
            if (!instruction.partial) {
              break;
            }
            if (this.options.suppressErrors && !dictionaries.has(instruction.name)) {
              break;
            }
            oldMembers = dictionaries.get(instruction.name).idl.members;
            oldMembers.push(...instruction.members);
            extAttrs = dictionaries.get(instruction.name).idl.extAttrs;
            extAttrs.push(...instruction.extAttrs);
            break;
          case "implements":
            if (this.options.suppressErrors && !interfaces.has(instruction.target)) {
              break;
            }
            interfaces.get(instruction.target).implements(instruction.implements);
            break;
        }
      }
    }
  }

  * _writeFiles(outputDir) {
    const utilsText = yield fs.readFile(path.resolve(__dirname, "output/utils.js"));
    yield fs.writeFile(this.options.utilPath, utilsText);

    const { interfaces, dictionaries } = this.ctx;

    for (const obj of interfaces.values()) {
      if (obj.imported) {
        continue;
      }

      let source = obj.toString();

      const implDir = path.relative(outputDir, obj.implDir).replace(/\\/g, "/"); // fix windows file paths
      let implFile = implDir + "/" + obj.name + this.ctx.implSuffix;
      if (implFile[0] !== ".") {
        implFile = "./" + implFile;
      }

      let relativeUtils = path.relative(outputDir, this.options.utilPath).replace(/\\/g, "/");
      if (relativeUtils[0] !== ".") {
        relativeUtils = "./" + relativeUtils;
      }

      source = `
        "use strict";

        const conversions = require("webidl-conversions");
        const utils = require("${relativeUtils}");
        ${source}
        const Impl = require("${implFile}.js");
      `;

      source = this._prettify(source);

      yield fs.writeFile(path.join(outputDir, obj.name + ".js"), source);
    }

    for (const obj of dictionaries.values()) {
      if (obj.imported) {
        continue;
      }

      let source = obj.toString();

      let relativeUtils = path.relative(outputDir, this.options.utilPath).replace(/\\/g, "/");
      if (relativeUtils[0] !== ".") {
        relativeUtils = "./" + relativeUtils;
      }

      source = `
        "use strict";

        const conversions = require("webidl-conversions");
        const utils = require("${relativeUtils}");
        ${source}
      `;

      source = this._prettify(source);

      yield fs.writeFile(path.join(outputDir, obj.name + ".js"), source);
    }
  }

  _prettify(source) {
    return prettier.format(source, {
      printWidth: 120
    });
  }

  generate(outputDir) {
    if (!this.options.utilPath) {
      this.options.utilPath = path.join(outputDir, "utils.js");
    }

    return co(function* () {
      this.ctx.initialize();
      const sources = yield* this._collectSources();
      const contents = yield* this._readFiles(sources);
      this._parse(outputDir, contents);
      yield* this._writeFiles(outputDir);
    }.bind(this));
  }
}

module.exports = Transformer;
