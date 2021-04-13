// @flow
/*
 * MIT License
 *
 * Copyright (c) 2017 Uber Node.js
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import thrift from './thriftrw';
import prettier from 'prettier';
import path from 'path';
import {id} from './identifier';
import type {
  Ast,
  Struct,
  Union,
  Exception,
  Identifier,
  Literal,
  Field,
  Enum,
  Typedef,
  FunctionDefinition,
  Service,
  Const,
  ConstList,
  ConstEntry,
  ConstMap,
  AstNode,
  Definition,
} from './ast-types';

const thriftOptions = {
  strict: false,
  allowFilesystemAccess: true,
  allowOptionalArguments: true,
};

function includeIdentifierOfFilename(filename: string): string {
  const match = filename.match(/([^/]+).thrift$/);
  if (!match) {
    throw new Error(`Unable to determine identifier for filename ${filename}`);
  }
  return match[1];
}

const primitives = {
  binary: 'Buffer',
  bool: 'boolean',
  byte: 'number',
  i8: 'number',
  i16: 'number',
  i32: 'number',
  i64: 'number',
  double: 'number',
  string: 'string',
  void: 'void',
};

const i64Mappings = {
  '': '(number | Buffer)',
  Long: '(number | thrift2flow$Long)',
  long: '(number | thrift2flow$Long)',
  Date: '(number | string)',
  Integer: 'number',
  Number: 'number',
  Buffer: '(number | Buffer)',
  Double: 'number',
};

type Parsed = {|
  asts: {[filename: string]: Ast},
  filename: string,
  idls: {[filename: string]: {||}},
|};

const longDeclaration = "import thrift2flow$Long from 'long'";

export class ThriftFileConverter {
  thriftPath: string;
  thrift: Parsed;
  withsource: boolean;
  ast: Ast;
  identifiersTable: {[key: string]: AstNode};

  constructor(thriftPath: string, withsource: boolean, parsed?: Parsed) {
    this.thriftPath = path.resolve(thriftPath);
    this.thrift =
      parsed || thrift({...thriftOptions, entryPoint: this.thriftPath});
    this.ast = this.thrift.asts[this.thrift.filename];
    this.initIdentifiersTable();
    this.withsource = withsource;
  }

  initIdentifiersTable() {
    this.identifiersTable = {};
    const includes = this.ast.headers.filter(f => f.type === 'Include');
    includes
      .map(({id}) => {
        const filename = path.resolve(path.dirname(this.thrift.filename), id);
        const includeIdentifier = includeIdentifierOfFilename(filename);
        return {
          filename: filename,
          includePrefix: `${includeIdentifier}.`,
        };
      })
      .concat([
        {
          filename: this.thrift.filename,
          includePrefix: '',
        },
      ])
      .map(
        ({
          filename,
          includePrefix,
        }: {|
          filename: string,
          includePrefix: string,
        |}) => {
          this.thrift.asts[filename].definitions.forEach(definition => {
            const identifier = `${includePrefix}${definition.id.name}`;
            this.identifiersTable[identifier] = definition;
            if (definition.type === 'Enum') {
              definition.definitions.forEach(enumDefinition => {
                this.identifiersTable[
                  `${includePrefix}${definition.id.name}.${enumDefinition.id.name}`
                ] = enumDefinition;
              });
            }
          });
        }
      );
  }

  generateFlowFile: (?boolean) => string = skipFormat => {
    const result = [
      '// @flow',
      this.withsource && `// Source: ${this.thriftPath}`,
      this.generateImports(),
      ...this.ast.definitions.map(this.convertDefinitionToCode),
    ]
      .filter(Boolean)
      .join('\n\n');
    return (skipFormat === true
      ? result
      : prettier.format(result, {parser: 'flow'})
    ).replace(`${longDeclaration};`, `/*:: ${longDeclaration}; */`); // use flow comment to avoid need for runtime installation of `long` package
  };

  convertDefinitionToCode = (def: Definition) => {
    const defType = def.type;
    switch (def.type) {
      case 'Struct':
      case 'Exception':
        return this.generateStruct(def);
      case 'Union':
        return this.generateUnion(def);
      case 'Enum':
        return this.generateEnum(def);
      case 'Typedef':
        return this.generateTypedef(def);
      case 'Service':
        return this.generateService(def);
      case 'Const':
        return this.generateConst(def);
      default:
        throw new Error(
          `Unknown definition type ${defType} found in ${path.basename(
            this.thriftPath
          )}`
        );
    }
  };

  generateService = (def: Service) => {
    const functions = def.functions.map(this.generateFunction).join(',');
    if (def.baseService && def.baseService.name) {
      if (def.functions.length === 0) {
        return `export type ${id(def.id.name)} = ${def.baseService.name}`;
      }
      return `export type ${id(def.id.name)} = {\n${functions}, ...${
        def.baseService.name
      }};`;
    }
    return `export type ${id(def.id.name)} = {${functions}};`;
  };

  generateFunction = (fn: FunctionDefinition) =>
    `${fn.id.name}: (${
      fn.fields.length ? this.generateStructContents([...fn.fields], true) : ''
    }) => ${this.convertType(fn.returns)}`;

  generateTypedef = (def: Typedef) => {
    if (def.valueType.type === 'Identifier') {
      const otherDef = this.identifiersTable[def.valueType.name];
      if (otherDef.type === 'Enum') {
        return this.generateEnum(otherDef, def.id.name);
      }
    }
    return `export type ${id(def.id.name)} = ${this.convertType(
      def.valueType
    )};`;
  };

  generateEnumUnion = (def: Enum) => {
    return def.definitions.map((d, index) => `"${d.id.name}"`).join(' | ');
  };

  generateEnum = (def: Enum, otherName?: string) => {
    const values = def.definitions
      .map((d, index) => `'${d.id.name}': '${d.id.name}',`)
      .join('\n');
    return `export const ${
      otherName !== undefined ? otherName : def.id.name
    }: $ReadOnly<{|
  ${values}
|}>  = Object.freeze({
  ${values}
});`;
  };

  generateConst = (def: Const) => {
    let value: string | void;
    let enumType: ?string;
    let readOnly = false;
    if (def.value.type === 'ConstList') {
      value = `[${def.value.values
        .map((val: Identifier | Literal) => {
          if (val.type === 'Identifier') {
            if (val.name.includes('.')) {
              const {definition} = this.definitionOfIdentifier(
                val.name,
                this.thrift.filename
              );
              if (definition.type == 'EnumDefinition') {
                const scope = val.name.split('.')[0];
                const defAndFilename = this.definitionOfIdentifier(
                  scope,
                  this.thrift.filename
                );
                if (enumType === undefined && this.isEnum(defAndFilename)) {
                  enumType = `${this.getIdentifier(scope, 'type')}[]`;
                }
              }
            }
            return this.getIdentifier(val.name, 'value');
          }
          if (val.type === 'Literal' && typeof val.value === 'string') {
            return `'${val.value}'`;
          }
          return val.value;
        })
        .join(',')}]`;
    } else {
      if (def.value.type === 'Literal') {
        if (typeof def.value.value === 'string') {
          // String
          value = `'${def.value.value}'`;
        } else {
          // Number
          value = String(def.value.value);
        }
      }
      if (
        def.fieldType.type === 'BaseType' &&
        def.fieldType.baseType === 'i64' &&
        value !== undefined
      ) {
        const numValue = Number(value) > 0 ? Number(value) : -Number(value);
        return `export const ${id(def.id.name)}: ${String(numValue)} = ${String(
          numValue
        )};`;
      }
      if (def.value.type === 'Identifier') {
        // $FlowFixMe
        return `export const ${id(def.id.name)} = ${id(def.value.name)}`;
      }
    }
    if (value === undefined) {
      if (def.value.type === 'ConstMap') {
        readOnly = true;
        value = this.generateConstMap(def.value);
      } else {
        throw new Error(`value is undefined for ${def.id.name}`);
      }
    }
    const fieldType = enumType || this.convertType(def.fieldType, def);
    return `export const ${id(def.id.name)}: ${
      readOnly ? `$ReadOnly<${fieldType}>` : fieldType
    } = ${value};`;
  };

  generateConstList(def: ConstList) {
    return `[${def.values
      .map(entry => {
        if (entry.type === 'Identifier') {
          return entry.name;
        } else {
          return `"${entry.value}"`;
        }
      })
      .join(',')}]`;
  }

  generateConstEntry = (entry: ConstEntry) => {
    let key;
    let value;
    const entryValueType = entry.value.type;
    const entryKeyType = entry.key.type;
    if (entry.key.type === 'Literal') {
      if (typeof entry.key.value === 'string') {
        key = `'${entry.key.value}'`;
      } else {
        // Keys are always strings in JS.
        key = `'${entry.key.value}'`;
      }
    } else if (entry.key.type === 'Identifier') {
      // computed key based off of identifier.
      key = `[${this.getIdentifier(entry.key.name, 'value')}]`;
    } else {
      throw new Error(`Unhandled entry.key.type ${entryKeyType}`);
    }
    if (entry.value.type === 'Literal') {
      if (typeof entry.value.value === 'number') {
        value = `${entry.value.value}`;
      } else if (typeof entry.value.value === 'string') {
        value = `'${entry.value.value}'`;
      } else {
        console.error(entry.value);
        throw new Error(`Unhandled const map entry type`);
      }
    } else if (entry.value.type === 'Identifier') {
      if (entry.value.name === 'false' || entry.value.name === 'true') {
        value = entry.value.name;
      } else {
        value = this.getIdentifier(entry.value.name, 'value');
      }
    } else if (entry.value.type === 'ConstMap') {
      value = this.generateConstMap(entry.value);
    } else if (entry.value.type === 'ConstList') {
      value = this.generateConstList(entry.value);
    } else {
      throw new Error(`Unhandled entry.key.type ${entryValueType}`);
    }
    if (key === undefined || value === undefined) {
      console.error('key', key);
      console.error('value', value);
      console.error(entry);
      throw new Error(`key or value is undefined`);
    }
    const result = `${key}: ${value},`;
    return result;
  };

  generateConstMap = (def: ConstMap) => {
    return `{
      ${def.entries.map(entry => this.generateConstEntry(entry)).join('\n')}
    } `;
  };

  generateStruct = ({id: {name}, fields}: Struct | Exception) =>
    `export type ${id(name)} = ${this.generateStructContents(fields)};`;

  generateStructContents = (fields: Array<Field>, readOnly?: boolean) =>
   `${readOnly === true ? '$ReadOnly<' : ''}{|${fields
      .map((field: Field) => {
        const valueType = field.valueType;
        let optionalPrefix = this.isOptional(field) ? '?' : '';
        let value =
          valueType.type === 'Identifier'
            ? this.getIdentifier(valueType.name, 'type')
            : this.convertType(valueType, null, readOnly);
        return `${field.name}${optionalPrefix}:${optionalPrefix}${value};`;
      })
      .join('\n')}|}${readOnly === true ? '>' : ''}`;

  generateUnion = ({id: {name}, fields}: Union) =>
    `export type ${id(name)} = ${this.generateUnionContents(fields)};`;

  generateUnionContents = (fields: Array<Field>) => {
    if (!fields.length) {
      return '{||}';
    }
    return fields
      .map(
        (f: Field) =>
          `{|type: "${f.name}",${f.name}: ${this.convertType(f.valueType)}|}`
      )
      .join(' | ');
  };

  isOptional = (field: Field) => field.optional;

  generateImports = () => {
    const includes = this.ast.headers.filter(f => f.type === 'Include');
    const relativePaths: Array<string> = includes
      .map(i => path.parse(i.id))
      .map((parsed: {dir: string, name: string}) =>
        path.join(parsed.dir, parsed.name)
      )
      .map((p: string) => (p.startsWith('.') ? p : `./${p}`));
    const generatedImports = relativePaths.map((relpath, index) => {
      let baseName = path.basename(relpath);
      let hasConflictingImport = true;
      while (hasConflictingImport) {
        hasConflictingImport = relativePaths.some((rel, nextIndex) => {
          if (nextIndex > index && path.basename(rel) === baseName) {
            return true;
          }
          return false;
        });
        if (hasConflictingImport) {
          baseName = `_${baseName}`;
        }
      }
      return `import * as ${id(baseName)} from '${relpath}';`;
    });

    if (this.isLongDefined()) {
      generatedImports.push(longDeclaration);
    }
    return generatedImports.join('\n');
  };

  getImportAbsPaths: () => Array<string> = () =>
    Object.keys(this.thrift.idls).map((p: string) => path.resolve(p));

  /**
   * Given an identifier and relative filename, returns the file it's
   * defined in and it's definition.
   */
  definitionOfIdentifier(
    identifier: string,
    filename: string
  ): {|definition: AstNode, filename: string|} {
    const ast: Ast = this.thrift.asts[filename];
    if (!ast) {
      throw new Error(`Ast not found for filename ${filename}`);
    }
    let definition: ?AstNode;
    for (let current of ast.definitions) {
      if (current.id.name === identifier) {
        definition = current;
        break;
      }
      if (current.type === 'Enum') {
        for (let currentEnum of current.definitions) {
          if (`${current.id.name}.${currentEnum.id.name}` === identifier) {
            definition = currentEnum;
            break;
          }
        }
      }
    }
    if (definition) {
      return {definition, filename};
    }
    const [scope, name] = identifier.includes('.')
      ? identifier.split('.')
      : [null, identifier];
    if (scope === null) {
      throw new Error(
        `local identifier ${identifier} missing in file ${filename}, name ${name}`
      );
    }
    const headerInclude = ast.headers
      .filter(f => f.type === 'Include')
      .find(header => {
        return path.basename(header.id, '.thrift') === `${scope}`;
      });
    if (!headerInclude) {
      throw new Error(
        `header include not found for scope ${scope} in filename ${filename}.`
      );
    }
    const otherFilename = path.resolve(
      path.dirname(filename),
      headerInclude.id
    );
    return this.definitionOfIdentifier(name, otherFilename);
  }

  /**
   * Follows typedef references to determine if a given identifier refers to an Enum.
   */
  isEnum({
    definition,
    filename,
  }: {
    definition: AstNode,
    filename: string,
  }): boolean {
    if (definition.type === 'Enum') {
      return true;
    }
    if (
      definition.type === 'Typedef' &&
      definition.valueType.type === 'Identifier'
    ) {
      return this.isEnum(
        this.definitionOfIdentifier(definition.valueType.name, filename)
      );
    }
    return false;
  }

  getIdentifier = (identifier: string, kind: 'type' | 'value'): string => {
    // Enums can be referenced as either types and as values. For flow we need to slip
    // this up.
    const {
      definition: def,
      filename: defFilename,
    } = this.definitionOfIdentifier(identifier, this.thrift.filename);
    if (kind === 'type') {
      if (this.isEnum({definition: def, filename: defFilename})) {
        return `$Values<typeof ${identifier}>`;
      }
      return id(identifier);
    }
    // It's okay to refernce an enum definition from a value position.
    return id(identifier);
  };

  isLongDefined = () => {
    let queue: $ReadOnlyArray<AstNode> = this.ast.definitions.slice();
    while (queue.length) {
      let [node, ...newQueue] = queue;
      queue = newQueue;
      if (
        node.type === 'Struct' ||
        node.type === 'Exception' ||
        node.type === 'Union'
      ) {
        for (const field of node.fields) {
          queue = [...queue, field.valueType];
        }
      } else if (node.type === 'Service') {
        for (const func of node.functions) {
          queue = [...queue, func.returns];
          for (const field of func.fields) {
            queue = [...queue, field.valueType];
          }
        }
      } else if (
        node &&
        node.annotations &&
        (node.annotations['js.type'] === 'Long' ||
          node.annotations['js.type'] === 'long')
      ) {
        return true;
      }
      if (node.valueType) {
        queue = [...queue, node.valueType];
      }
    }
    return false;
  };

  convertBaseType(t: AstNode, def?: ?Definition): string | void {
    if (t.type !== 'BaseType') {
      return undefined;
    }
    if (t.baseType === 'i64') {
      const jsType: string | void = t.annotations['js.type'];
      if (
        jsType === 'long' ||
        jsType === 'Long' ||
        jsType === 'Date' ||
        jsType === 'Integer' ||
        jsType === 'Number' ||
        jsType === 'Buffer' ||
        jsType === 'Double'
      ) {
        return i64Mappings[jsType];
      }
      if (jsType !== undefined) {
        throw new Error(`Unknown or invalid js.type annotation of ${jsType}.`);
      }
      return i64Mappings[''];
      // i64 defaults to Buffer
    }
    if (
      t.baseType === 'string' &&
      def &&
      def.type === 'Const' &&
      typeof def.value.value === 'string'
    ) {
      return `'${def.value.value}'`;
    }
    return primitives[t.baseType];
  }

  convertEnumType(thriftValueType: AstNode): string | void {
    if (this.isEnumIdentifier(thriftValueType)) {
      // Enums are values, not types. To refer to the type,
      // we use $Values<...>.
      if (thriftValueType.type !== 'Identifier') {
        throw new Error(
          'Assertion failure. Enum reference has to be an identifier'
        );
      }
      return `$Values<typeof ${thriftValueType.name}>`;
    }
    return undefined;
  }

  convertMapType(t: AstNode, def?: ?Definition, readOnly?: ?boolean): string | void {
    if (t.type === 'Map' && def) {
      const valueType = this.convertType(t.valueType);
      if (def.type === 'Const' && def.value.type === 'ConstMap') {
        const entries = def.value.entries.map(entry => {
          if (entry.key.type === 'Identifier') {
            const identifierValue: AstNode = this.identifiersTable[
              entry.key.name
            ];
            if (identifierValue.type === 'EnumDefinition') {
              return `'${identifierValue.id.name}': ${valueType}`;
            } else if (
              identifierValue.type === 'Const' &&
              typeof identifierValue.value.value === 'string'
            ) {
              return `'${identifierValue.value.value}': ${valueType}`;
            } else {
              throw new Error(
                `Unknown identifierValue type ${identifierValue.type}`
              );
            }
          } else if (entry.key.type === 'Literal') {
            return readOnly === true ? `'${entry.key.value}': $ReadOnly<${valueType}>` : `'${entry.key.value}': ${valueType}`;
          } else {
            throw new Error('unsupported');
          }
        });
        return `{|  ${entries.join(',')} |}`;
      }
    }
    if (t.type === 'Map') {
      const keyType = this.convertType(t.keyType);
      const valueType = this.convertType(t.valueType);
      return `{| [${keyType}]: ${valueType} |}`;
    }
    return undefined;
  }

  isEnumIdentifier(def: AstNode) {
    // Enums export const, not type
    if (def.name === undefined) {
      return undefined;
    }
    return this.identifiersTable[def.name].type === 'Enum';
  }

  convertType(t: AstNode, def?: ?Definition, readOnly?: boolean): string {
    if (!t) {
      throw new Error(`Assertion failed. t is not defined.`);
    }
    let type: string | void =
      this.convertArrayType(t) ||
      this.convertMapType(t, def, readOnly) ||
      this.convertEnumType(t) ||
      this.convertBaseType(t, def);
    if (type !== undefined) {
      return type;
    }
    if (t.type === 'Identifier') {
      return id(t.name);
    }
    throw new Error(`Unhandled convertion for node ${JSON.stringify(t)}`);
  }

  convertArrayType(node: AstNode) {
    if (node.type === 'List' || node.type === 'Set') {
      return `${this.convertType(node.valueType)}[]`;
    }
    return undefined;
  }
}
