import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const workspace = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = path.join(workspace, "packages/features/src");
const browserAreas = new Set(["ui", "contracts", "locales"]);
const manifest = JSON.parse(
  readFileSync(path.join(workspace, "packages/features/package.json"), "utf8"),
);
const dependencies = new Set(
  Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }),
);

export function checkSource(file, source, root = sourceRoot) {
  const area = path.relative(root, file).split(path.sep)[0];
  const browser = browserAreas.has(area);
  const errors = [];
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function check(specifier) {
    if (!specifier || !ts.isStringLiteralLike(specifier)) {
      errors.push(`${file}: computed module imports are forbidden`);
      return;
    }
    const name = specifier.text;
    if (name.startsWith(".")) {
      const relative = path.relative(
        root,
        path.resolve(path.dirname(file), name),
      );
      const targetArea = relative.split(path.sep)[0];
      if (
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        (browser && !browserAreas.has(targetArea)) ||
        (area !== "ui" && targetArea === "ui")
      ) {
        errors.push(`${file}: forbidden import ${name}`);
      }
    } else if (name.startsWith("@bitsentry-escalator/features/")) {
      const subpath = name.slice("@bitsentry-escalator/features/".length);
      if (
        !("./" + subpath in manifest.exports) ||
        (browser && !browserAreas.has(subpath)) ||
        (area !== "ui" && subpath === "ui")
      )
        errors.push(`${file}: forbidden export ${name}`);
    } else {
      const dependency = name.startsWith("@")
        ? name.split("/").slice(0, 2).join("/")
        : name.split("/")[0];
      if (
        browser
          ? !(
              (area === "ui" && ["react", "react-dom"].includes(dependency)) ||
              (["contracts", "ui"].includes(area) && dependency === "zod")
            )
          : (!dependencies.has(dependency) && !name.startsWith("node:")) ||
            (!browser && ["react", "react-dom"].includes(dependency))
      )
        errors.push(`${file}: forbidden dependency ${name}`);
    }
  }
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    )
      check(node.moduleSpecifier);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      check(node.argument.literal);
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      check(node.moduleReference.expression);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    )
      check(node.arguments[0]);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return errors;
}
export function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory()
      ? walk(file)
      : /\.[cm]?tsx?$/.test(file)
        ? [file]
        : [];
  });
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const failures = walk(sourceRoot).flatMap((file) =>
    checkSource(file, readFileSync(file, "utf8")),
  );
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else console.log("Escalator browser/server boundaries passed.");
}
