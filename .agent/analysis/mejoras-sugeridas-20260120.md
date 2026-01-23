# 🎯 Mejoras Sugeridas - Sistema de Captura RUT

**Fecha:** 2026-01-20  
**Contexto:** Post-implementación de filtro semántico, ruta rápida y pre-warm mejorado

---

## 1️⃣ FILTRO SEMÁNTICO - Detección Mejorada

### Problema Actual
El filtro semántico detecta números cardinales básicos, pero puede mejorar detectando más patrones comunes de confusión.

### Mejoras Propuestas

#### A. Detectar más palabras cardinales
```javascript
// Agregar al array de cardinalWords:
const cardinalWords = [
    'millon', 'millones', 'mil', 'miles', 'ciento', 'cientos', 'cien', 
    'millar', 'millares',
    // 🎯 NUEVOS:
    'billón', 'billones', 'trillón', 'trillones',  // Números muy grandes
    'millardo', 'millardos',  // Variante de millón
    'centena', 'centenas', 'decena', 'decenas',  // Agrupaciones
    'docena', 'docenas', 'grupo', 'grupos'  // Agrupaciones no numéricas
];
```

#### B. Detectar frases comunes de confusión
```javascript
// Agregar después de cardinalWords:
const confusionPhrases = [
    'cuánto es', 'cuánto vale', 'cuánto cuesta',  // Preguntas de precio
    'número de', 'número del', 'número de la',  // Referencias a otros números
    'teléfono', 'celular', 'móvil',  // Números telefónicos
    'dirección', 'calle', 'avenida',  // Direcciones
    'código', 'clave', 'pin',  // Códigos
    'fecha', 'año', 'mes', 'día'  // Fechas
];

const hasConfusionPhrase = confusionPhrases.some(phrase => lowerText.includes(phrase));
if (hasConfusionPhrase) {
    return { isValid: false, reason: 'CONFUSION_PHRASE' };
}
```

#### C. Detectar patrones de RUT inválidos (formato incorrecto)
```javascript
// Agregar validación de formato RUT antes de webhook:
// RUT válido: 7-8 dígitos + guion + 1 dígito/k
const rutPattern = /^[0-9]{7,8}[-]?[0-9kK]$/;
const hasRutFormat = rutPattern.test(text.replace(/\s/g, ''));

if (digitCount >= 7 && digitCount <= 10 && !hasRutFormat && !hasDigitSequence) {
    // Tiene dígitos pero no tiene formato de RUT
    return { isValid: false, reason: 'INVALID_RUT_FORMAT_PATTERN' };
}
```

---

## 2️⃣ TRACKING DE INTENTOS - Métricas Granulares

### Problema Actual
El contador de intentos es básico y no diferencia entre tipos de errores.

### Mejoras Propuestas

#### A. Tracking por tipo de error
```javascript
// En phased-capsule.js, agregar tracking granular:
const errorType = result?.reason || 'UNKNOWN';
const errorTrackingKey = `rut:errors:${callKey}`;
const errorCount = await redis.incr(`${errorTrackingKey}:${errorType}`);
await redis.expire(`${errorTrackingKey}:${errorType}`, 300);

// Logging mejorado:
log('info', `💊 [QUINTERO PHASED] ❌ Invalid RUT. Attempts: ${attempts}, ErrorType: ${errorType}, Count: ${errorCount}`);
```

#### B. Métricas agregadas en Redis
```javascript
// Guardar métricas para análisis:
const metricsKey = `rut:metrics:${callKey}`;
await redis.hSet(metricsKey, {
    totalAttempts: attempts,
    lastErrorType: errorType,
    lastErrorTime: Date.now(),
    semanticRejects: await redis.get(`${errorTrackingKey}:CARDINAL_NUMBER`) || 0,
    webhookRejects: await redis.get(`${errorTrackingKey}:INVALID_RUT_FORMAT`) || 0
});
await redis.expire(metricsKey, 600);
```

---

## 3️⃣ RUTA RÁPIDA - Optimización de Confidence Threshold

### Problema Actual
El threshold de confidence está fijo en 85, pero podría ser dinámico.

### Mejoras Propuestas

#### A. Confidence threshold adaptativo
```javascript
// En phased-capsule.js, hacer threshold dinámico:
const getConfidenceThreshold = (attempts) => {
    // Primera vez: más estricto (90)
    if (attempts === 0) return 90;
    // Segundo intento: más permisivo (85)
    if (attempts === 1) return 85;
    // Tercer intento+: muy permisivo (75) para no perder oportunidades
    return 75;
};

const threshold = getConfidenceThreshold(attempts);
if (rutState.state === IdentityState.VALIDADO && rutState.confidence >= threshold) {
    // Ruta rápida...
}
```

#### B. Validación cruzada con filtro semántico
```javascript
// Antes de ruta rápida, verificar que no sea rechazado por filtro semántico:
const semanticCheck = semanticFilter(rutState.normalized);
if (semanticCheck.isValid && rutState.confidence >= threshold) {
    // Ruta rápida segura
}
```

---

## 4️⃣ PRE-WARM - Mejora de Persistencia

### Problema Actual
El pre-warm durante greeting es bueno, pero podría mejorarse con retry logic.

### Mejoras Propuestas

#### A. Retry logic para pre-warm fallido
```javascript
// En voice-engine.js, agregar retry con backoff:
const preWarmWithRetry = async (maxRetries = 2) => {
    for (let i = 0; i < maxRetries; i++) {
        try {
            await ensureSTT();
            return true;
        } catch (e) {
            if (i < maxRetries - 1) {
                const delay = 500 * (i + 1); // Backoff: 500ms, 1000ms
                log("debug", `🔄 [ENGINE] Pre-warm retry ${i + 1}/${maxRetries} en ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                log("warn", `⚠️ [ENGINE] Pre-warm falló después de ${maxRetries} intentos`);
            }
        }
    }
    return false;
};
```

#### B. Pre-warm condicional basado en historial
```javascript
// Solo pre-warm si no ha fallado recientemente:
const preWarmFailedKey = `stt:prewarm:failed:${linkedId}`;
const hasRecentFailure = await redis.get(preWarmFailedKey);

if (!hasRecentFailure && shouldPrewarm) {
    // Intentar pre-warm
    const success = await preWarmWithRetry();
    if (!success) {
        await redis.set(preWarmFailedKey, 'true', { EX: 60 }); // No intentar por 60s
    }
}
```

---

## 5️⃣ OBSERVABILIDAD - Logging y Métricas Mejoradas

### Problema Actual
Los logs son buenos pero falta agregación de métricas para análisis.

### Mejoras Propuestas

#### A. Métricas de performance
```javascript
// En invokeRutWebhook, agregar timing:
const webhookTiming = {
    semanticFilterTime: Date.now() - semanticFilterStart,
    webhookCallTime: Date.now() - webhookStart,
    totalTime: Date.now() - invokeStart
};

// Guardar en Redis para análisis:
await redis.lPush(`metrics:webhook:timing:${callKey}`, JSON.stringify(webhookTiming));
await redis.expire(`metrics:webhook:timing:${callKey}`, 3600);
```

#### B. Eventos estructurados para análisis
```javascript
// Crear eventos estructurados:
const emitEvent = async (eventType, data) => {
    const event = {
        type: eventType,
        timestamp: Date.now(),
        callKey: callKey,
        ...data
    };
    
    // Guardar en Redis para procesamiento batch
    await redis.lPush(`events:${eventType}`, JSON.stringify(event));
    await redis.expire(`events:${eventType}`, 86400); // 24h
};

// Uso:
await emitEvent('RUT_SEMANTIC_REJECT', {
    reason: semanticCheck.reason,
    text: trimmedText.substring(0, 20)
});
```

---

## 6️⃣ UX - Mensajes de Error Más Claros

### Problema Actual
Los mensajes de retry son genéricos.

### Mejoras Propuestas

#### A. Mensajes específicos por tipo de error
```javascript
// En phased-capsule.js, mensajes personalizados:
const getRetryMessage = (errorType, attempts) => {
    const messages = {
        'CARDINAL_NUMBER': 'Por favor, dígame su RUT número por número, usando el teclado si es necesario.',
        'INSUFFICIENT_DIGITS': 'Necesito escuchar su RUT completo. Por favor, dígalo nuevamente.',
        'NO_DIGIT_SEQUENCE': 'No pude entender bien. Por favor, dígame su RUT más despacio.',
        'TEXT_WITHOUT_DIGITS': 'Por favor, dígame solo los números de su RUT.',
        'INVALID_RUT_FORMAT': 'El formato no es correcto. Por favor, dígalo nuevamente.'
    };
    
    return messages[errorType] || (attempts >= 2 
        ? 'Para ayudarle mejor, puede usar el teclado para ingresar su RUT.'
        : 'Por favor, dígame su RUT nuevamente.');
};

// Usar en res.audio o res.ttsText según corresponda
```

---

## 7️⃣ PERFORMANCE - Caching de Validaciones

### Problema Actual
El filtro semántico se ejecuta cada vez, incluso para textos similares.

### Mejoras Propuestas

#### A. Cache de resultados del filtro semántico
```javascript
// En invokeRutWebhook, agregar cache:
const semanticCacheKey = `semantic:cache:${textHash}`;
const cachedResult = await redis.get(semanticCacheKey);

if (cachedResult) {
    const cached = JSON.parse(cachedResult);
    log("debug", `🔍 [ENGINE] Filtro semántico (cached): ${cached.isValid ? 'VÁLIDO' : 'RECHAZADO'} (reason: ${cached.reason})`);
    if (!cached.isValid) {
        // Usar resultado cacheado
        return false;
    }
} else {
    // Ejecutar filtro y cachear
    const semanticCheck = semanticFilter(trimmedText);
    await redis.set(semanticCacheKey, JSON.stringify(semanticCheck), { EX: 300 });
    // ...
}
```

---

## 8️⃣ ARQUITECTURA - Separación de Concerns

### Problema Actual
El filtro semántico está embebido en invokeRutWebhook.

### Mejoras Propuestas

#### A. Extraer filtro semántico a módulo separado
```javascript
// Crear: services/core/engine/filters/semantic-rut-filter.js
export class SemanticRutFilter {
    static filter(text) {
        // Lógica del filtro
    }
    
    static getRejectionReason(text) {
        // Retornar razón específica
    }
}

// Usar en voice-engine.js:
import { SemanticRutFilter } from './filters/semantic-rut-filter.js';
const semanticCheck = SemanticRutFilter.filter(trimmedText);
```

---

## 📊 Priorización

### 🔴 Alta Prioridad (Implementar Pronto)
1. **Filtro semántico mejorado** (1A, 1B) - Reduce falsos positivos
2. **Tracking de intentos granular** (2A, 2B) - Mejora debugging
3. **Mensajes de error específicos** (6A) - Mejora UX

### 🟡 Media Prioridad (Implementar en Próxima Iteración)
4. **Confidence threshold adaptativo** (3A) - Optimiza ruta rápida
5. **Pre-warm con retry** (4A, 4B) - Mejora confiabilidad
6. **Observabilidad mejorada** (5A, 5B) - Facilita análisis

### 🟢 Baja Prioridad (Nice to Have)
7. **Caching de validaciones** (7A) - Optimización menor
8. **Separación de concerns** (8A) - Refactoring arquitectónico

---

## 🧪 Testing Sugerido

1. **Test de filtro semántico**: Probar con números cardinales, frases de confusión
2. **Test de ruta rápida**: Verificar threshold adaptativo con diferentes confidence scores
3. **Test de pre-warm**: Verificar retry logic y persistencia
4. **Test de métricas**: Verificar que se guardan correctamente en Redis

---

## 📝 Notas Finales

- Todas las mejoras son **backward compatible**
- No requieren cambios en la API externa
- Pueden implementarse incrementalmente
- Mejoran tanto performance como UX
