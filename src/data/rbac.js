/**
 * Catálogo de permisos y roles (usado por seedAdmin y por el test que verifica
 * que toda ruta protegida tenga su permiso sembrado).
 * Vive en src/ para que siempre se despliegue con el backend.
 *
 * Regla: si agregás un `requirePermission('x')` en una ruta, la clave `x` tiene
 * que existir acá. Si no, ningún rol salvo el ADMIN legado (wildcard) puede
 * recibirla, y el permiso ni siquiera aparece en la pantalla de roles.
 */

const PERMISSIONS = [
  { key: 'stats.view', module: 'stats', description: 'Ver el panel de metricas (usuarios, ingresos, retencion)' },
  { key: 'users.view', module: 'users', description: 'Ver listado de usuarios' },
  { key: 'users.edit', module: 'users', description: 'Editar datos de usuarios' },
  { key: 'users.ban', module: 'users', description: 'Banear/reactivar usuarios' },
  { key: 'users.manage', module: 'users', description: 'Crear y eliminar usuarios, y correr tareas de mantenimiento' },
  { key: 'roles.manage', module: 'roles', description: 'Crear/editar roles y permisos' },
  { key: 'content.moderate', module: 'content', description: 'Borrar posts, grupos y stories, y resolver reportes' },
  { key: 'exercises.manage', module: 'exercises', description: 'Gestionar la libreria global de ejercicios' },
  { key: 'groups.create', module: 'groups', description: 'Crear grupos' },
  { key: 'groups.edit', module: 'groups', description: 'Editar cualquier grupo' },
  { key: 'groups.disable', module: 'groups', description: 'Deshabilitar cualquier grupo' },
  { key: 'communities.create', module: 'communities', description: 'Crear comunidades' },
  { key: 'communities.edit', module: 'communities', description: 'Editar cualquier comunidad' },
  { key: 'communities.disable', module: 'communities', description: 'Deshabilitar cualquier comunidad' },
  { key: 'challenges.create_global', module: 'challenges', description: 'Crear retos globales' },
  { key: 'challenges.edit', module: 'challenges', description: 'Editar cualquier reto' },
  { key: 'challenges.disable', module: 'challenges', description: 'Deshabilitar cualquier reto' },
  { key: 'rankings.manage', module: 'rankings', description: 'Configurar rangos y categorias' },
  { key: 'plans.manage', module: 'plans', description: 'Gestionar planes, features y precios' },
  { key: 'feature_flags.manage', module: 'feature_flags', description: 'Encender/apagar modulos completos' },
  { key: 'scoring.manage', module: 'scoring', description: 'Configurar la economia de puntos y ajustar puntos de usuarios' },
  { key: 'audit.view', module: 'audit', description: 'Ver el log de auditoria completo' },
  { key: 'notifications.manage', module: 'notifications', description: 'Enviar notificaciones/broadcast y ver plantillas' },
  { key: 'businesses.moderate', module: 'marketplace', description: 'Aprobar/rechazar negocios del marketplace' },
  { key: 'rewards.moderate', module: 'marketplace', description: 'Moderar recompensas del marketplace' },
  { key: 'business.profile.manage', module: 'marketplace', description: 'Gestionar perfil de negocio' },
  { key: 'rewards.manage', module: 'marketplace', description: 'Gestionar recompensas del negocio' },
  { key: 'redemptions.validate', module: 'marketplace', description: 'Validar cupones canjeados' }
];

/**
 * ADMIN y ATHLETE van sin permisos a propósito: ADMIN pasa por el wildcard del
 * enum Role legado y ATHLETE no toca nada del panel.
 */
const ROLE_DEFINITIONS = [
  { name: 'ADMIN', description: 'Administrador del sistema (acceso total, via role legado)', isSystem: true, permissions: [] },
  { name: 'ATHLETE', description: 'Usuario atleta estandar', isSystem: true, permissions: [] },
  {
    name: 'MODERATOR',
    description: 'Moderador de contenido y comunidad',
    isSystem: false,
    permissions: [
      'users.view',
      'groups.edit',
      'groups.disable',
      'communities.edit',
      'communities.disable',
      'audit.view',
      'content.moderate'
    ]
  },
  {
    name: 'COACH',
    description: 'Entrenador con vista sobre sus atletas',
    isSystem: false,
    permissions: ['users.view', 'challenges.create_global', 'challenges.edit']
  },
  {
    name: 'BUSINESS',
    description: 'Negocio adherido al marketplace de recompensas',
    isSystem: true,
    permissions: ['business.profile.manage', 'rewards.manage', 'redemptions.validate']
  }
];

const PERMISSION_KEYS = new Set(PERMISSIONS.map((p) => p.key));

module.exports = { PERMISSIONS, ROLE_DEFINITIONS, PERMISSION_KEYS };
