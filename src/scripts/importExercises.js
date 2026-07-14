/**
 * Script de importación del dataset de ejercicios (AbbosMamadaliyev/exercises-dataset).
 * Lee src/data/exercises.json y hace upsert de cada ejercicio en la tabla `exercises`.
 * Idempotente: se puede volver a ejecutar sin duplicar datos.
 *
 * Uso: npm run seed:exercises
 */
const fs = require('fs');
const path = require('path');
const prisma = require('../lib/prisma');

const DATA_PATH = path.join(__dirname, '../data/exercises.json');

const run = async () => {
  console.log('[ImportExercises] Leyendo dataset...');
  const raw = fs.readFileSync(DATA_PATH, 'utf-8');
  const exercises = JSON.parse(raw);
  console.log(`[ImportExercises] ${exercises.length} ejercicios encontrados.`);

  let imported = 0;
  let failed = 0;

  for (const ex of exercises) {
    try {
      const image = ex.image ? `/exercises-media/${ex.image}` : null;
      const gifUrl = ex.gif_url ? `/exercises-media/${ex.gif_url}` : null;

      await prisma.exercise.upsert({
        where: { id: ex.id },
        update: {
          name: ex.name,
          category: ex.category,
          bodyPart: ex.body_part,
          equipment: ex.equipment,
          target: ex.target,
          muscleGroup: ex.muscle_group,
          secondaryMuscles: ex.secondary_muscles || [],
          instructionsEn: ex.instructions?.en || '',
          instructionsEs: ex.instructions?.es || '',
          instructionsJson: ex.instructions || {},
          mediaId: ex.media_id || null,
          image,
          gifUrl,
          attribution: ex.attribution || null
        },
        create: {
          id: ex.id,
          name: ex.name,
          category: ex.category,
          bodyPart: ex.body_part,
          equipment: ex.equipment,
          target: ex.target,
          muscleGroup: ex.muscle_group,
          secondaryMuscles: ex.secondary_muscles || [],
          instructionsEn: ex.instructions?.en || '',
          instructionsEs: ex.instructions?.es || '',
          instructionsJson: ex.instructions || {},
          mediaId: ex.media_id || null,
          image,
          gifUrl,
          attribution: ex.attribution || null
        }
      });
      imported++;
      
      if (imported % 50 === 0) {
        console.log(`[ImportExercises] Progreso: ${imported} / ${exercises.length} importados...`);
      }
    } catch (error) {
      failed++;
      console.error(`[ImportExercises] Error importando ejercicio ${ex.id} (${ex.name}):`, error.message);
    }
  }

  console.log(`[ImportExercises] Completado. Importados: ${imported}. Fallidos: ${failed}.`);
  process.exit(failed > 0 ? 1 : 0);
};

run().catch((error) => {
  console.error('[ImportExercises] Error fatal:', error);
  process.exit(1);
});
