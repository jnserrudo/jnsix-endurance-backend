const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const Groq = require('groq-sdk');

class AIService {
  constructor() {
    this.provider = process.env.AI_PROVIDER || 'openai';
    console.log('AI Provider configured:', this.provider);

    // Clientes por API key presente (texto + visión). El provider activo
    // define el modelo de chat; la visión usa GROQ_VISION_MODEL / etc.
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });
    }

    if (process.env.ANTHROPIC_API_KEY) {
      this.anthropic = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY
      });
    }

    if (process.env.GROQ_API_KEY) {
      this.groq = new Groq({
        apiKey: process.env.GROQ_API_KEY
      });
    }

    if (this.provider === 'openai' && this.openai) {
      this.model = process.env.OPENAI_MODEL || 'gpt-4-turbo-preview';
      console.log('OpenAI initialized with model:', this.model);
    } else if (this.provider === 'anthropic' && this.anthropic) {
      this.model = process.env.ANTHROPIC_MODEL || 'claude-3-sonnet-20240229';
      console.log('Anthropic initialized with model:', this.model);
    } else if (this.provider === 'groq' && this.groq) {
      this.model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
      console.log('Groq initialized with model:', this.model);
    }

    if (!this.openai && !this.anthropic && !this.groq) {
      console.error('No AI provider initialized. Check environment variables.');
    } else if (this.groq) {
      console.log('Groq vision OCR model:', this.getGroqVisionModelCandidates()[0]);
    }
  }

  /** Quita comillas accidentales del .env */
  sanitizeModelId(value) {
    return String(value || '')
      .trim()
      .replace(/^["']|["']$/g, '');
  }

  /**
   * Modelos multimodal conocidos en Groq (orden preferido).
   * En cuentas free a veces Scout no está habilitado; qwen/qwen3.6-27b sí.
   */
  getGroqVisionModelCandidates() {
    const configured = this.sanitizeModelId(process.env.GROQ_VISION_MODEL);
    const chatModel = this.sanitizeModelId(process.env.GROQ_MODEL || this.model);
    const TEXT_ONLY = new Set([
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'llama-3.1-70b-versatile',
      'gemma2-9b-it',
      'mixtral-8x7b-32768',
    ]);

    const defaults = [
      'qwen/qwen3.6-27b',
      'meta-llama/llama-4-scout-17b-16e-instruct',
      'meta-llama/llama-4-maverick-17b-128e-instruct',
    ];

    const ordered = [];
    const push = (id) => {
      if (!id || TEXT_ONLY.has(id) || ordered.includes(id)) return;
      ordered.push(id);
    };

    push(configured);
    for (const id of defaults) push(id);
    // Nunca usar el modelo de chat si es solo-texto.
    if (chatModel && !TEXT_ONLY.has(chatModel)) push(chatModel);
    return ordered.length ? ordered : defaults;
  }

  async analyzeActivity(activity, analysisType, customPrompt = null, maxTokens = 1500) {
    const prompt = customPrompt || this.buildPrompt(activity, analysisType);
    
    try {
      if (this.provider === 'openai') {
        return await this.analyzeWithOpenAI(prompt, maxTokens);
      } else if (this.provider === 'anthropic') {
        return await this.analyzeWithAnthropic(prompt, maxTokens);
      } else if (this.provider === 'groq') {
        return await this.analyzeWithGroq(prompt, maxTokens);
      } else {
        throw new Error('No AI provider configured');
      }
    } catch (error) {
      throw new Error(`AI analysis failed: ${error.message}`);
    }
  }

  async analyzeWithOpenAI(prompt, maxTokens = 1500) {
    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'system',
          content: 'Eres un entrenador experto en triatlón y trail running. Proporciona análisis técnicos, precisos y accionables basados en datos de actividades deportivas. No utilices ningún tipo de emoji en tus respuestas, solo texto plano o markdown.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.7,
      max_tokens: maxTokens
    });

    return {
      response: response.choices[0].message.content,
      tokensUsed: response.usage.total_tokens,
      model: this.model
    };
  }

  async analyzeWithAnthropic(prompt, maxTokens = 1500) {
    const response = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system: 'Eres un entrenador experto en triatlón y trail running. Proporciona análisis técnicos, precisos y accionables basados en datos de actividades deportivas. No utilices ningún tipo de emoji en tus respuestas, solo texto plano o markdown.',
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    });

    return {
      response: response.content[0].text,
      tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
      model: this.model
    };
  }

  async analyzeWithGroq(prompt, maxTokens = 1500) {
    const response = await this.groq.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'system',
          content: 'Eres un entrenador experto en triatlón y trail running. Proporciona análisis técnicos, precisos y accionables basados en datos de actividades deportivas. No utilices ningún tipo de emoji en tus respuestas, solo texto plano o markdown.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.7,
      max_tokens: maxTokens
    });

    return {
      response: response.choices[0].message.content,
      tokensUsed: response.usage.total_tokens,
      model: this.model
    };
  }

  buildPrompt(activity, analysisType) {
    const baseInfo = `
Actividad: ${activity.name}
Tipo: ${activity.type}
Distancia: ${activity.distanceKm.toFixed(2)} km
Desnivel: ${activity.elevationM.toFixed(0)} m
Tiempo: ${this.formatTime(activity.movingTime)}
Ritmo promedio: ${this.calculatePace(activity.distanceKm, activity.movingTime)} min/km
${activity.averageHr ? `FC promedio: ${activity.averageHr} bpm` : ''}
${activity.maxHr ? `FC máxima: ${activity.maxHr} bpm` : ''}
`;

    const prompts = {
      TRAINING_RECOMMENDATION: `${baseInfo}

Responde en Markdown legible en móvil: secciones con ## (sin numeración) y viñetas (-), no outlines numerados.

## Evaluacion del rendimiento
- Resumen de cómo se ejecutó esta sesión

## Recomendaciones
- Acciones concretas para mejorar

## Entrenamientos complementarios
- Sugerencias de sesiones de apoyo

## Proximas sesiones
- Aspectos a trabajar`,

      PERFORMANCE_ANALYSIS: `${baseInfo}

Responde en Markdown legible en móvil: secciones con ## (sin numeración) y viñetas (-), no outlines numerados.

## Ritmo y consistencia
- Análisis del ritmo y su estabilidad

## Gestion del desnivel
- Cómo se afrontaron las pendientes

## Respuesta cardiovascular
- Lectura de FC y esfuerzo

## Fortalezas y mejoras
- Puntos fuertes y áreas a trabajar

## Comparacion con estandares
- Contexto frente a estándares para este tipo de actividad`,

      RACE_STRATEGY: `${baseInfo}

Responde en Markdown legible en móvil: secciones con ## (sin numeración) y viñetas (-), no outlines numerados.

## Estrategia de ritmo
- Ritmo recomendado para una competición similar

## Energia y nutricion
- Gestión de energía e hidratación/nutrición

## Puntos clave del recorrido
- Momentos críticos a planificar

## Tiempo objetivo
- Estimación realista de tiempo`,

      FATIGUE_ANALYSIS: `${baseInfo}

Responde en Markdown legible en móvil: secciones con ## (sin numeración) y viñetas (-), no outlines numerados.

## Indicadores de fatiga
- Señales observadas en los datos

## Recuperacion recomendada
- Tiempo de descanso sugerido

## Actividades de recuperacion
- Sesiones o hábitos de recovery

## Senales de alerta
- Qué monitorear en los próximos días`,

      TIME_PREDICTION: `${baseInfo}

Responde en Markdown legible en móvil: secciones con ## (sin numeración) y viñetas (-), no outlines numerados.

## Estimaciones de tiempo
- Predicciones para 5K, 10K, 21K y 42K

## Factores que afectan
- Variables que pueden alterar el rendimiento

## Margen de mejora
- Potencial realista de mejora

## Entrenamientos clave
- Sesiones prioritarias para alcanzar objetivos`,

      GENERAL_INSIGHT: `${baseInfo}

Responde en Markdown legible en móvil: secciones con ## (sin numeración) y viñetas (-), no outlines numerados.

## Aspectos destacados
- Lo más relevante de la sesión

## Observaciones tecnicas
- Detalles técnicos útiles

## Consejos practicos
- Acciones concretas

## Motivacion
- Perspectiva y refuerzo positivo`
    };

    return prompts[analysisType] || prompts.GENERAL_INSIGHT;
  }

  formatTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m ${secs}s`;
  }

  calculatePace(distanceKm, timeSeconds) {
    if (!distanceKm || !timeSeconds) return '0:00';
    const paceMinPerKm = (timeSeconds / 60) / distanceKm;
    const minutes = Math.floor(paceMinPerKm);
    const seconds = Math.round((paceMinPerKm - minutes) * 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  async chatWithCoach(systemPrompt, chatMessages) {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...chatMessages
    ];

    try {
      if (this.provider === 'openai') {
        const response = await this.openai.chat.completions.create({
          model: this.model,
          messages,
          temperature: 0.7,
          max_tokens: 1500
        });
        return {
          response: response.choices[0].message.content,
          tokensUsed: response.usage.total_tokens,
          model: this.model
        };
      } else if (this.provider === 'anthropic') {
        const response = await this.anthropic.messages.create({
          model: this.model,
          max_tokens: 1500,
          system: systemPrompt,
          messages: chatMessages
        });
        return {
          response: response.content[0].text,
          tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
          model: this.model
        };
      } else if (this.provider === 'groq') {
        const response = await this.groq.chat.completions.create({
          model: this.model,
          messages,
          temperature: 0.7,
          max_tokens: 1500
        });
        return {
          response: response.choices[0].message.content,
          tokensUsed: response.usage.total_tokens,
          model: this.model
        };
      } else {
        throw new Error('No AI provider configured');
      }
    } catch (error) {
      throw new Error(`AI chat failed: ${error.message}`);
    }
  }

  async generateTrainingPlan(userProfile, goalInput, weeks = 12, simulations = []) {
    const goal = typeof goalInput === 'string' ? { goal: goalInput } : goalInput;
    const simulationSummary = simulations.length
      ? simulations
          .map((s) => {
            const pace = s.distanceKm > 0 ? (s.movingTime / 60 / s.distanceKm).toFixed(2) : 'N/A';
            return `- ${s.name}: ${s.distanceKm} km, +${s.elevationM || 0} m, ritmo ${pace} min/km`;
          })
          .join('\n')
      : '- Sin simulaciones vinculadas';

    const prompt = `
Genera un plan de entrenamiento estructurado en formato JSON, estricto y sin texto adicional.

Perfil del atleta:
- Nivel: ${userProfile.level || 'Intermedio'}
- Deporte principal: ${userProfile.primarySport || goal.sportType || 'No especificado'}
- Peso: ${userProfile.weightKg || 'No especificado'} kg
- Altura: ${userProfile.heightCm || 'No especificada'} cm
- Género: ${userProfile.gender || 'No especificado'}
${userProfile.hrZones ? `- Zonas FC (hrZones): ${JSON.stringify(userProfile.hrZones)}` : ''}
${userProfile.paceZones ? `- Zonas de ritmo (paceZones): ${JSON.stringify(userProfile.paceZones)}` : ''}
${userProfile.powerZones ? `- Zonas de potencia (powerZones): ${JSON.stringify(userProfile.powerZones)}` : ''}
- Objetivo: ${goal.goal}
- Disciplina objetivo: ${goal.sportType || 'No especificada'}
- Distancia objetivo: ${goal.targetDistance ?? 'No especificada'} km
- Desnivel objetivo: ${goal.targetElevation ?? 'No especificado'} m
- Fecha objetivo: ${goal.targetDate || 'No especificada'}
- Tiempo objetivo: ${goal.targetTime || 'No especificado'}
- Terreno: ${goal.terrainType || 'No especificado'}
- Notas/restricciones: ${goal.notes || 'Ninguna'}
- Duración del plan: ${weeks} semanas
- Disponibilidad: ${userProfile.availability || '4-5 días/semana'}
- Días preferidos: ${(goal.preferredDays || []).join(', ') || 'Sin preferencia'}
- Distancia máxima actual: ${userProfile.currentDistance || 'No especificada'}
- Volumen semanal actual: ${goal.currentWeeklyVolume ?? 'No especificado'} km
- Volumen semanal objetivo: ${goal.targetWeeklyVolume ?? 'No especificado'} km
- RPE preferido: ${goal.preferredRpe ?? 'No especificado'}
- Incluir fuerza: ${goal.includeStrength === false ? 'No' : 'Sí'}

Sesiones favoritas del atleta (incluir variantes cuando tenga sentido):
${
  (goal.savedSessions || []).length
    ? goal.savedSessions
        .map((s) => {
          const target =
            s.targetMetric && s.targetValue != null
              ? ` (${s.targetValue} ${s.targetMetric === 'DISTANCE' ? 'km' : 'min'})`
              : '';
          return `- ${s.name}${target}${s.sportType ? ` [${s.sportType}]` : ''}${s.description ? `: ${s.description}` : ''}`;
        })
        .join('\n')
    : '- Ninguna'
}

Ejercicios de fuerza disponibles (usá estos nombres en sesiones de fuerza si corresponde):
${
  (goal.strengthExercises || []).length
    ? goal.strengthExercises
        .map((e) => `- ${e.name} (${e.muscleGroup || e.target || 'general'}${e.equipment ? `, ${e.equipment}` : ''})`)
        .join('\n')
    : '- Catálogo no disponible'
}

Simulaciones recientes vinculadas:
${simulationSummary}

Reglas:
- Distribuye las sesiones solo en los días preferidos cuando estén informados.
- Incluye progresión, semanas de descarga y taper antes de la fecha objetivo.
- Incluye fuerza si fue solicitada; en esas sesiones mencioná ejercicios concretos del listado cuando sea posible.
- Si hay sesiones favoritas, incorporá al menos algunas a lo largo del plan.
- Cada sesión debe indicar el esfuerzo/RPE dentro de description.
- Genera todas las semanas del plan con una cantidad de sesiones coherente con la disponibilidad.

El formato JSON de salida debe ser exactamente:
{
  "name": "Nombre del Plan",
  "description": "Descripción general",
  "level": "INTERMEDIATE",
  "weeks": ${weeks},
  "sessions": [
    {
      "week": 1,
      "day": 1,
      "name": "Carrera suave",
      "description": "Correr a ritmo conversacional",
      "rationale": "Mantiene el volumen aeróbico sin acumular fatiga residual.",
      "targetMetric": "DISTANCE",
      "targetValue": 5
    }
  ]
}

Cada sesión DEBE incluir "rationale": una frase corta en español explicando por qué está esa sesión (adaptación, recuperación, especificidad, etc.).

Responde SOLO el JSON.`;

    const result = await this.analyzeActivity({}, 'GENERAL_INSIGHT', prompt, 8000);
    
    // Attempt to parse JSON safely
    try {
      const raw = typeof result === 'string' ? result : result.response;
      const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      const jsonStr =
        firstBrace >= 0 && lastBrace > firstBrace
          ? cleaned.slice(firstBrace, lastBrace + 1)
          : cleaned;
      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed.sessions) || parsed.sessions.length === 0) {
        throw new Error('El plan no contiene sesiones');
      }
      return parsed;
    } catch (e) {
      console.error('Error parsing AI training plan JSON:', e);
      throw new Error('AI returned invalid format');
    }
  }

  /**
   * Vision OCR: prioriza el mismo provider del Coach (Groq gratis con modelo multimodal).
   * Fallback opcional a OpenAI/Anthropic solo si están configurados.
   */
  isVisionAvailable() {
    return Boolean(this.groq || this.openai || this.anthropic);
  }

  getVisionStatus() {
    // Preferir el AI_PROVIDER activo cuando tiene cliente (mismo stack que el Coach).
    if (this.provider === 'groq' && this.groq) {
      return {
        available: true,
        provider: 'groq',
        model: this.getGroqVisionModelCandidates()[0],
        candidates: this.getGroqVisionModelCandidates(),
      };
    }
    if (this.provider === 'openai' && this.openai) {
      return {
        available: true,
        provider: 'openai',
        model:
          this.sanitizeModelId(process.env.OPENAI_VISION_MODEL) ||
          this.sanitizeModelId(process.env.OPENAI_MODEL) ||
          'gpt-4o',
      };
    }
    if (this.provider === 'anthropic' && this.anthropic) {
      return {
        available: true,
        provider: 'anthropic',
        model:
          this.sanitizeModelId(process.env.ANTHROPIC_VISION_MODEL) ||
          this.sanitizeModelId(process.env.ANTHROPIC_MODEL) ||
          'claude-3-5-sonnet-20241022',
      };
    }
    if (this.groq) {
      return {
        available: true,
        provider: 'groq',
        model: this.getGroqVisionModelCandidates()[0],
        candidates: this.getGroqVisionModelCandidates(),
      };
    }
    if (this.openai) {
      return {
        available: true,
        provider: 'openai',
        model:
          this.sanitizeModelId(process.env.OPENAI_VISION_MODEL) ||
          this.sanitizeModelId(process.env.OPENAI_MODEL) ||
          'gpt-4o',
      };
    }
    if (this.anthropic) {
      return {
        available: true,
        provider: 'anthropic',
        model:
          this.sanitizeModelId(process.env.ANTHROPIC_VISION_MODEL) ||
          this.sanitizeModelId(process.env.ANTHROPIC_MODEL) ||
          'claude-3-5-sonnet-20241022',
      };
    }
    return { available: false, provider: null, model: null };
  }

  isModelUnavailableError(error) {
    const msg = String(error?.message || '').toLowerCase();
    const code = error?.error?.code || error?.code;
    return (
      error?.status === 404 ||
      code === 'model_not_found' ||
      msg.includes('does not exist') ||
      msg.includes('do not have access') ||
      msg.includes('model_not_found')
    );
  }

  isVisionUnsupportedError(error) {
    const msg = String(error?.message || '').toLowerCase();
    return (
      msg.includes('does not support image') ||
      msg.includes('must be a string') ||
      (msg.includes('image') && msg.includes('not support'))
    );
  }

  isTransientVisionError(error) {
    const msg = String(error?.message || '').toLowerCase();
    return (
      error?.status === 429 ||
      error?.status === 503 ||
      msg.includes('over capacity') ||
      msg.includes('rate limit')
    );
  }

  async createGroqVisionCompletion(model, messages, maxTokens) {
    try {
      return await this.groq.chat.completions.create({
        model,
        messages,
        temperature: 0.1,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      });
    } catch (error) {
      // Algunos modelos no aceptan response_format; reintentar sin JSON mode.
      if (this.isModelUnavailableError(error) || this.isVisionUnsupportedError(error)) {
        throw error;
      }
      console.warn('[Vision] Groq JSON mode retry without response_format:', error.message);
      return this.groq.chat.completions.create({
        model,
        messages,
        temperature: 0.1,
        max_tokens: maxTokens,
      });
    }
  }

  /**
   * @param {string} base64Image - raw base64 without data: prefix
   * @param {string} mimeType
   * @param {string} prompt
   * @param {number} maxTokens
   */
  async analyzeImage(base64Image, mimeType = 'image/jpeg', prompt, maxTokens = 1200) {
    const status = this.getVisionStatus();
    if (!status.available) {
      const err = new Error(
        'OCR no configurado. Con Groq necesitás GROQ_API_KEY y un modelo con visión (GROQ_VISION_MODEL).'
      );
      err.code = 'VISION_UNAVAILABLE';
      throw err;
    }

    const systemPrompt =
      'Sos un extractor de métricas deportivas. Respondé SOLO con JSON válido, sin markdown ni texto extra.';
    const userContent = [
      { type: 'text', text: prompt },
      {
        type: 'image_url',
        image_url: {
          url: `data:${mimeType};base64,${base64Image}`,
        },
      },
    ];

    if (status.provider === 'groq') {
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ];
      const candidates = status.candidates || this.getGroqVisionModelCandidates();
      let lastError = null;

      for (const model of candidates) {
        try {
          console.log('[Vision] Trying Groq model:', model);
          const response = await this.createGroqVisionCompletion(model, messages, maxTokens);
          return {
            response: response.choices[0].message.content,
            tokensUsed: response.usage?.total_tokens || 0,
            model,
          };
        } catch (error) {
          lastError = error;
          console.warn('[Vision] Groq model failed:', model, error.status, error.message);
          if (this.isTransientVisionError(error)) {
            const err = new Error(
              'El servicio de IA está saturado ahora. Esperá un minuto y reintentá.'
            );
            err.code = 'OCR_PROVIDER_BUSY';
            err.cause = error;
            throw err;
          }
          // Probar el siguiente candidato si el modelo no existe / no acepta imágenes.
          if (this.isModelUnavailableError(error) || this.isVisionUnsupportedError(error)) {
            continue;
          }
          throw error;
        }
      }

      const err = new Error(
        'Ningún modelo de visión de Groq respondió. En .env usá GROQ_VISION_MODEL=qwen/qwen3.6-27b (disponible en el plan free).'
      );
      err.code = 'VISION_UNAVAILABLE';
      err.cause = lastError;
      throw err;
    }

    if (status.provider === 'openai') {
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ];

      let response;
      try {
        response = await this.openai.chat.completions.create({
          model: status.model,
          messages,
          temperature: 0.1,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
        });
      } catch (error) {
        response = await this.openai.chat.completions.create({
          model: status.model,
          messages,
          temperature: 0.1,
          max_tokens: maxTokens,
        });
      }

      return {
        response: response.choices[0].message.content,
        tokensUsed: response.usage?.total_tokens || 0,
        model: status.model,
      };
    }

    const response = await this.anthropic.messages.create({
      model: status.model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType,
                data: base64Image,
              },
            },
            { type: 'text', text: prompt },
          ],
        },
      ],
    });

    return {
      response: response.content[0].text,
      tokensUsed: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
      model: status.model,
    };
  }
}

module.exports = new AIService();
