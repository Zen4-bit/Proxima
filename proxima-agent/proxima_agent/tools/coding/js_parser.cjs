const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const acornLoose = require('acorn-loose');

// Proxima — JS Parser.
// JavaScript AST parser using Acorn/Acorn-Loose. TypeScript (.ts/.tsx) support is best-effort.

function main() {
  if (process.argv.length < 3) {
    console.error("Usage: node js_parser.cjs <file_path> [max_nodes]");
    process.exit(1);
  }

  const filePath = process.argv[2];
  const maxNodes = parseInt(process.argv[3] || '50000', 10);

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  try {
    const code = fs.readFileSync(filePath, 'utf-8');
    // acorn-loose tolerates TS syntax and parsing errors.
    const ast = acornLoose.parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true, // required for line/column info
    });

    const results = {
      symbols: [],
      imports: [],
      references: [],
      relations: []
    };

    // Use exact positions (line:column) of declarations to exclude only the declaration site, preserving references.
    const declSites = new Set();
    const noteDecl = (idNode) => {
      if (idNode && idNode.loc && idNode.loc.start) {
        declSites.add(`${idNode.loc.start.line}:${idNode.loc.start.column}`);
      }
    };

    let nodeCount = 0;

    function getLine(loc) {
      return loc && loc.start ? loc.start.line : 1;
    }

    function getCol(loc) {
      return loc && loc.start ? loc.start.column : 0;
    }

    function getEndLine(loc) {
      return loc && loc.end ? loc.end.line : 1;
    }

    function walk(node, parentScope = "") {
      if (!node) return;
      nodeCount++;
      if (nodeCount > maxNodes) {
        throw new Error(`AST limit exceeded: more than ${maxNodes} nodes parsed`);
      }

      const loc = node.loc;
      
      // 1. Extract Imports
      if (node.type === 'ImportDeclaration') {
        const modulePath = node.source ? node.source.value : '';
        const line = getLine(loc);
        if (node.specifiers) {
          node.specifiers.forEach(spec => {
            const symName = spec.local ? spec.local.name : '';
            results.imports.push({
              module_path: modulePath,
              symbol_name: symName,
              line_number: line,
              is_local: modulePath.startsWith('.') || modulePath.startsWith('/')
            });
          });
        }
        return; // No need to traverse imports children
      }

      // Check for CommonJS Require
      if (node.type === 'VariableDeclarator' && node.init && 
          node.init.type === 'CallExpression' && 
          node.init.callee && node.init.callee.name === 'require' &&
          node.init.arguments && node.init.arguments.length > 0 &&
          node.init.arguments[0].type === 'Literal') {
        
        const modulePath = node.init.arguments[0].value;
        const line = getLine(loc);
        const isLocal = modulePath.startsWith('.') || modulePath.startsWith('/');
        
        if (node.id && node.id.type === 'Identifier') {
          results.imports.push({
            module_path: modulePath,
            symbol_name: node.id.name,
            line_number: line,
            is_local: isLocal
          });
        } else if (node.id && node.id.type === 'ObjectPattern') {
          // Destructured require: const { User } = require('./user')
          node.id.properties.forEach(prop => {
            if (prop.key && prop.key.type === 'Identifier') {
              results.imports.push({
                module_path: modulePath,
                symbol_name: prop.key.name,
                line_number: line,
                is_local: isLocal
              });
            }
          });
        }
      }

      // 2. Extract Classes
      if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
        const name = node.id ? node.id.name : 'AnonymousClass';
        const fqn = parentScope ? `${parentScope}.${name}` : name;
        const line = getLine(loc);
        const endLine = getEndLine(loc);
        
        noteDecl(node.id);
        results.symbols.push({
          name: name,
          fully_qualified_name: fqn,
          type: 'class',
          start_line: line,
          end_line: endLine,
          signature: `class ${name}`
        });

        if (node.superClass && node.superClass.type === 'Identifier') {
          results.relations.push({
            source_fqn: fqn,
            target_fqn: node.superClass.name,
            relation_type: 'inherits'
          });
        }

        // Traverse class body with class FQN scope
        if (node.body && node.body.body) {
          node.body.body.forEach(member => {
            if (member.type === 'MethodDefinition') {
              const mName = member.key ? member.key.name : 'anonymous';
              const mFqn = `${fqn}.${mName}`;
              const mLine = getLine(member.loc);
              const mEndLine = getEndLine(member.loc);
              const isStatic = member.static ? "static " : "";
              const isAsync = member.value && member.value.async ? "async " : "";
              
              noteDecl(member.key);
              results.symbols.push({
                name: mName,
                fully_qualified_name: mFqn,
                type: 'function',
                start_line: mLine,
                end_line: mEndLine,
                signature: `${isStatic}${isAsync}${mName}()`
              });

              results.relations.push({
                source_fqn: fqn,
                target_fqn: mFqn,
                relation_type: 'contains'
              });

              walk(member.value, fqn);
            }
          });
        }
        return;
      }

      // 3. Extract Functions
      if (node.type === 'FunctionDeclaration') {
        const name = node.id ? node.id.name : 'anonymous';
        const fqn = parentScope ? `${parentScope}.${name}` : name;
        const line = getLine(loc);
        const endLine = getEndLine(loc);
        const isAsync = node.async ? "async " : "";
        
        noteDecl(node.id);
        results.symbols.push({
          name: name,
          fully_qualified_name: fqn,
          type: 'function',
          start_line: line,
          end_line: endLine,
          signature: `${isAsync}function ${name}()`
        });

        if (parentScope) {
          results.relations.push({
            source_fqn: parentScope,
            target_fqn: fqn,
            relation_type: 'contains'
          });
        }

        walk(node.body, fqn);
        return;
      }

      // Check for const myFunc = () => {} or let myFunc = function() {}
      if (node.type === 'VariableDeclarator' && node.init && 
          (node.init.type === 'ArrowFunctionExpression' || node.init.type === 'FunctionExpression') &&
          node.id && node.id.type === 'Identifier') {
        
        const name = node.id.name;
        const fqn = parentScope ? `${parentScope}.${name}` : name;
        const line = getLine(loc);
        const endLine = getEndLine(node.init.loc || loc);
        const isAsync = node.init.async ? "async " : "";
        
        noteDecl(node.id);
        results.symbols.push({
          name: name,
          fully_qualified_name: fqn,
          type: 'function',
          start_line: line,
          end_line: endLine,
          signature: `${isAsync}const ${name} = () => {}`
        });

        if (parentScope) {
          results.relations.push({
            source_fqn: parentScope,
            target_fqn: fqn,
            relation_type: 'contains'
          });
        }

        walk(node.init.body, fqn);
        return;
      }

      // 4. Extract References (Identifiers)
      if (node.type === 'Identifier' && node.name) {
        // Exclude declarations names to avoid self-referencing
        results.references.push({
          symbol_name: node.name,
          line: getLine(loc),
          column: getCol(loc),
          kind: 'identifier'
        });
      }

      // Recursive traversal of all keys in the AST node
      for (const key in node) {
        if (key === 'loc' || key === 'type') continue;
        const child = node[key];
        if (child && typeof child === 'object') {
          if (Array.isArray(child)) {
            child.forEach(item => walk(item, parentScope));
          } else {
            walk(child, parentScope);
          }
        }
      }
    }

    walk(ast);

    // Exclude declaration sites from references.
    results.references = results.references.filter(
      ref => !declSites.has(`${ref.line}:${ref.column}`)
    );

    console.log(JSON.stringify(results, null, 2));

  } catch (err) {
    console.error(`JS Parser Error: ${err.message}`);
    process.exit(1);
  }
}

main();
