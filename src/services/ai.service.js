const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const Groq = require('groq-sdk');

class AIService {
  constructor() {
    this.provider = process.env.AI_PROVIDER || 'openai';
    console.log('AI Provider configured:', this.provider);
    
    if (this.provider === 'openai' && process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });
      this.model = process.env.OPENAI_MODEL || 'gpt-4-turbo-preview';
      console.log('OpenAI initialized with model:', this.model);
    }
    
    if (this.provider === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
      this.anthropic = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY
      });
      this.model = process.env.ANTHROPIC_MODEL || 'claude-3-sonnet-20240229';
      console.log('Anthropic initialized with model:', this.model);
    }
    
    if (this.provider === 'groq' && process.env.GROQ_API_KEY) {
      this.groq = new Groq({
        apiKey: process.env.GROQ_API_KEY
      });
      this.model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
      console.log('Groq initialized with model:', this.model);
    }
    
    if (!this.openai && !this.anthropic && !this.groq) {
      console.error('No AI provider initialized. Check environment variables.');
    }
  }

  async analyzeActivity(activity, analysisType, customPrompt = null) {
    const prompt = customPrompt || this.buildPrompt(activity, analysisType);
    
    try {
      if (this.provider === 'openai') {
        return await this.analyzeWithOpenAI(prompt);
      } else if (this.provider === 'anthropic') {
        return await this.analyzeWithAnthropic(prompt);
      } else if (this.provider === 'groq') {
        return await this.analyzeWithGroq(prompt);
      } else {
        throw new Error('No AI provider configured');
      }
    } catch (error) {
      throw new Error(`AI analysis failed: ${error.message}`);
    }
  }

  async analyzeWithOpenAI(prompt) {
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
      max_tokens: 1500
    });

    return {
      response: response.choices[0].message.content,
      tokensUsed: response.usage.total_tokens,
      model: this.model
    };
  }

  async analyzeWithAnthropic(prompt) {
    const response = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 1500,
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

  async analyzeWithGroq(prompt) {
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
      max_tokens: 1500
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

Basándote en estos datos, proporciona:
1. Evaluación del rendimiento en esta sesión
2. Recomendaciones específicas para mejorar
3. Sugerencias de entrenamientos complementarios
4. Aspectos a trabajar en próximas sesiones`,

      PERFORMANCE_ANALYSIS: `${baseInfo}

Analiza el rendimiento en detalle:
1. Análisis del ritmo y consistencia
2. Gestión del desnivel
3. Respuesta cardiovascular
4. Puntos fuertes y áreas de mejora
5. Comparación con estándares para este tipo de actividad`,

      RACE_STRATEGY: `${baseInfo}

Proporciona una estrategia de carrera para una competición similar:
1. Estrategia de ritmo recomendada
2. Gestión de la energía y nutrición
3. Puntos clave a considerar en el recorrido
4. Tiempo objetivo realista`,

      FATIGUE_ANALYSIS: `${baseInfo}

Evalúa el nivel de fatiga y recuperación:
1. Indicadores de fatiga en los datos
2. Tiempo de recuperación recomendado
3. Actividades de recuperación sugeridas
4. Señales de alerta a monitorear`,

      TIME_PREDICTION: `${baseInfo}

Predice tiempos para diferentes distancias:
1. Estimación para 5K, 10K, 21K, 42K
2. Factores que pueden afectar el rendimiento
3. Margen de mejora potencial
4. Entrenamientos clave para alcanzar objetivos`,

      GENERAL_INSIGHT: `${baseInfo}

Proporciona insights generales sobre esta actividad:
1. Aspectos destacados
2. Observaciones técnicas
3. Consejos prácticos
4. Motivación y perspectiva`
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

  async generateTrainingPlan(userProfile, goal, weeks = 12) {
    const prompt = `
Perfil del atleta:
- Nivel: ${userProfile.level || 'Intermedio'}
- Objetivo: ${goal}
- Duración del plan: ${weeks} semanas
- Disponibilidad: ${userProfile.availability || '4-5 días/semana'}
${userProfile.currentDistance ? `- Distancia actual: ${userProfile.currentDistance} km` : ''}

Genera un plan de entrenamiento estructurado que incluya:
1. Distribución semanal de entrenamientos
2. Tipos de sesiones (intervalos, fondo, recuperación, etc.)
3. Progresión gradual
4. Semanas de descarga
5. Consejos de nutrición y recuperación
`;

    return await this.analyzeActivity({}, 'GENERAL_INSIGHT', prompt);
  }
}

module.exports = new AIService();
