const fs = require('fs');
const path = require('path');
const { PERMISSIONS, ROLE_DEFINITIONS, PERMISSION_KEYS } = require('../src/data/rbac');

const SRC_DIR = path.join(__dirname, '..', 'src');

/** Archivos .js bajo src/, para buscar los requirePermission de todas las rutas. */
function listSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Saca comentarios para no confundir un ejemplo de documentación con una ruta real. */
function stripComments(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

/**
 * Devuelve [{ key, file }] por cada clave usada en un requirePermission(...).
 * Soporta varias claves en la misma llamada: requirePermission('a', 'b').
 */
function collectRequiredPermissions() {
  const found = [];
  const callRe = /requirePermission\(([^)]*)\)/g;
  const keyRe = /['"]([^'"]+)['"]/g;

  for (const file of listSourceFiles(SRC_DIR)) {
    const content = stripComments(fs.readFileSync(file, 'utf8'));

    let call;
    while ((call = callRe.exec(content)) !== null) {
      let key;
      while ((key = keyRe.exec(call[1])) !== null) {
        found.push({ key: key[1], file: path.relative(SRC_DIR, file) });
      }
    }
  }
  return found;
}

describe('catálogo de permisos (RBAC)', () => {
  it('encuentra rutas protegidas para analizar', () => {
    expect(collectRequiredPermissions().length).toBeGreaterThan(0);
  });

  it('toda ruta protegida usa un permiso que el seed siembra', () => {
    const huerfanos = collectRequiredPermissions().filter((u) => !PERMISSION_KEYS.has(u.key));

    // Un permiso sin fila en la tabla solo lo puede usar el ADMIN legado:
    // ningún rol custom podría recibirlo desde la pantalla de roles.
    expect(
      huerfanos.map((u) => `${u.key} (${u.file})`).sort()
    ).toEqual([]);
  });

  it('los roles solo reparten permisos que existen', () => {
    const invalidos = [];
    for (const rol of ROLE_DEFINITIONS) {
      for (const key of rol.permissions) {
        if (!PERMISSION_KEYS.has(key)) invalidos.push(`${rol.name} -> ${key}`);
      }
    }
    expect(invalidos).toEqual([]);
  });

  it('no hay claves de permiso duplicadas', () => {
    const keys = PERMISSIONS.map((p) => p.key);
    expect(keys.length).toBe(new Set(keys).size);
  });

  it('cada permiso tiene módulo y descripción para la pantalla de roles', () => {
    const incompletos = PERMISSIONS.filter((p) => !p.module || !p.description).map((p) => p.key);
    expect(incompletos).toEqual([]);
  });
});
