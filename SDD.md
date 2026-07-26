# SDD — Gentefarma WhatsApp Bot (`server.js`)

> **Propósito:** Documentar la arquitectura, flujos y dependencias críticas del bot para que cada fix no dañe lo que funciona.
> **Archivo fuente:** `server.js` (~6859 líneas, single-file Node.js/Express webhook)
> **Última revisión:** 2026-07-26

---

## 1. Nomenclatura de conceptos

| Término | Significado |
|---|---|
| **session** | Objeto de sesión almacenado en memoria (Map) o Redis. Contiene `userCity`, `mode`, `pendingSelectionResults`, `pendingRecipeMedicines`, `cart`, etc. |
| **OCR message** | Mensaje de WhatsApp que incluye una imagen/audio — el bot extrae texto con OpenAI Vision. |
| **recipeMode** | Flag booleano que activa comportamiento relajado en matching: umbrales más bajos (0.80 vs 0.93), sin `consultationGate` filter. Usado para recetas médicas OCR. |
| **hasOcrText** | Flag que indica que el mensaje actual vino de una extracción OCR (imagen). Se pasa via `context.hasOcrText`. **CRÍTICO:** debe consumirse inmediatamente (`context.hasOcrText = false`) para evitar re-entry en mensajes de follow-up. |
| **pendingRecipeMedicines** | Array de nombres de medicamentos extraídos de la receta OCR. Se guarda en `session` para reutilizarse cuando el usuario responde "Ciudad Bolívar". |
| **pendingCityRetry** | Objeto que guarda `{text, context}` de una búsqueda de medicamento pendiente mientras se pide la ciudad al usuario. |
| **consultationMode** | Modo de consulta estrict — activa `consultationGate` filter y `strictReferenceThreshold` alto (0.93). **No confundir con recipeMode.** |
| **ULTRA-GUARD** | Bloque que intercepta frases de selección (`"1"`, `"2 x 2"`, etc.) ANTES de cualquier extracción de medicamento. Corre en la línea 1768. |

---

## 2. Punto de entrada

```
handleEvent (689)
  └── processIncomingMessage (718)
        └── routeMessage (1761)
```

El webhook Evolution GO recibe un evento → `handleEvent` → `processIncomingMessage` extrae el body del payload y llama `routeMessage`.

---

## 3. Flujo principal de `routeMessage` (1761)

El orden de los bloques es **FIJO**. Cada bloque termina con `return` o deja pasar al siguiente.

```
routeMessage(phone, text, session, context = {})
│
├─ 1. DEFINIR hasOcrText AL INICIO (1763)
│     const hasOcrText = Boolean(context?.hasOcrText)
│     if (context) context.hasOcrText = false  ← CRÍTICO: consume para evitar re-entry
│
├─ 2. ULTRA-GUARD (1768) — Selección pura ("1", "2 x 2")
│     Solo actúa si session tiene pending catalog options.
│
├─ 3. City Change check (1800) — "cambiar ciudad"
│
├─ 4. CITY GATE (1811) — Pide ciudad si userCity=null Y !hasOcrText
│     ⚠️ NO corre si hasOcrText=true (el OCR block maneja ciudad internamente)
│     Si detectCityFromText(text) → detecta ciudad → guarda userCity
│     Si looksLikeMedicine → guarda pendingCityRetry y pide ciudad
│
├─ 5. LLM INTENT (1864) — Clasificación con OpenAI
│     Si LLM retorna intent de alta confianza → handleLLMIntent → return
│
├─ 6. isHumanRequest (1908) → handoff
│
├─ 7. isMedicineInterestStatement (1914) → buildMenuMessage
│
├─ 8. URGENT DENYLIST (1920) — Bloquea affirmaciones vacío ("ok", "sí", "gracias")
│
├─ 9. consultationIsMedicine (1958) → searchAndBuildCatalogResponse
│     Pasa recipeMode:true, preExtractedMedicines:extractedMedicineRequests
│
├─ 10. isNewOrderNotification (1987)
│
├─ 11. isViableDirectQuery (2036) → searchAndBuildCatalogResponse
│
├─ 12. "LISTO" / "RESUMEN" (2047)
│
├─ 13. CITY EARLY DETECTION (2050) — Detecta ciudad ANTES de greetings
│
├─ 14. isGreetingOrMenu (2067)
│
├─ 15. THANKS, LOCATION, HORARIO, PAGO, MORE-INFO, PREV-CATALOG (2083)
│
├─ 16. OCR BLOCK (2128) — Solo si hasOcrText=true
│     ⚠️ Corre DESPUÉS del city gate para permitir skip con !hasOcrText
│     Sanitiza receta → extractRecipeMedicineLines
│     → session.pendingRecipeMedicines = allRecipeMedicinesList
│     → searchAndBuildCatalogResponse con recipeMode:true, ocrOnly:true
│
├─ 17. OCR-REUSE (2191) — Solo si pendingRecipeMedicines existe
│     Reutiliza medicines de receta para el follow-up ("Ciudad Bolívar")
│
├─ 18. SELECTION BLOCK (2215) — Carrito con números de opción
│
└─ 19. buildDefaultFallbackMessage — Último recurso
```

---

## 4. CITY GATE — Importantísimas (1811)

### Condition
```javascript
if ((!session.userCity || session.userCity === 'null' || session.userCity === 'undefined') && !hasOcrText)
```

**Regla de oro:** `hasOcrText` **DEBE** estar definido ANTES de este condition. Si no lo está → `ReferenceError`.

### Comportamiento
1. `pendingCityRetry` está set → texto es respuesta de ciudad → `detectCityFromText`
2. `detectCityFromText(text)` → ciudad detectada → guardar `userCity` → `routeMessage(pending.text)` recursivo
3. `looksLikeMedicine` → guardar `pendingCityRetry` → **pedir ciudad** (NO buscar)

### El bug de la receta OCR (encontrado 2026-07-26)
Cuando `userCity=null` y llega una receta OCR → `looksLikeMedicine` era truthy → el city gate guardaba `pendingCityRetry` y respondía "indícame tu ciudad" **ANTES** de que el OCR block se ejecutara.

**Fix:** `&& !hasOcrText` en el condition del city gate.

---

## 5. OCR BLOCK — Importantísimo (2128)

### Entry condition
```javascript
if (hasOcrText) { ... }
```

`hasOcrText` viene del `context` pasado desde `processIncomingMessage`. **NO** de `session`.

### Flujo interno
```
rawOcr = recipeSourceText || text
       ↓
sanitizePrescriptionText(rawOcr)  → prescriptionClean (múltiples drugs con RP:)
sanitizeMedicineBoxText(rawOcr)    → boxClean (empaque de drug individual)
sanitizeRecipeText(rawOcr)         → recipeClean (último recurso)
       ↓
allRecipeMedicines = prescriptionClean || boxClean || recipeClean
       ↓
extractRecipeMedicineLines(allRecipeMedicines) → ["ESOZ 40 MG", "LEPRIT 25 MG", ...]
       ↓
session.pendingRecipeMedicines = allRecipeMedicinesList  ← Guardar para follow-up
       ↓
searchAndBuildCatalogResponse(searchQuery, {
  hasOcrText: true,
  ocrOnly: true,
  recipeMode: true,
  preExtractedMedicines: allRecipeMedicinesList
})
       ↓
return catalogResult_ocr
```

### `hasOcrText` como "consumable"
```javascript
// AL INICIO de routeMessage (línea 1763):
const hasOcrText = Boolean(context?.hasOcrText);
if (context) context.hasOcrText = false;  // ← Consume para evitar re-entry

// DENTRO del OCR block (línea 2128):
if (context && context.hasOcrText) {
  context.hasOcrText = false;  // ← Doble consume (defensivo)
}
```

**Problema conocido:** si `hasOcrText` se define después del city gate (después de línea 1811), y el city gate lo usa → `ReferenceError: Cannot access 'hasOcrText' before initialization`.

---

## 6. searchAndBuildCatalogResponse (3056) — Función central

### Firma
```javascript
async function searchAndBuildCatalogResponse(text, session, options = {}, userInfo = {})
```

### Options relevantes
| Opción | Tipo | Efecto |
|---|---|---|
| `hasOcrText` | boolean | Omite city gate en caller |
| `ocrOnly` | boolean | `strictListMode = !ocrOnly`; pasa `recipeMode` a `searchMedicinesByName` |
| `recipeMode` | boolean | Omite `consultationGate` filter; baja threshold a 0.80 |
| `strictConsultationMode` | boolean | Activa `consultationMode` en `searchMedicinesByName` |
| `preExtractedMedicines` | string[] | Medicines pre-extraídas de receta OCR; evita re-extracción |
| `queryDosageSignatures` | string[] | Dosificaciones del texto original (ej. `["40mg","500mg"]`) |

### Flujo interno
```
dedupeStrings(preExtractedMedicines)           → preExt dedup
  ↓
dedupLLMMedicines(preExtMedicines)             → dedupedCandidates
  ↓
if (dedupedCandidates.length > 1) {
  // MULTI-MEDICINE LOOP (línea 3194)
  for (const medicineQuery of dedupedCandidates) {
    searchMedicinesByName(medicineQuery, { recipeMode, strictConsultationMode, ... })
    → groups[] o missingMedicines[]
  }
  session.lastSearch = groups[0]
  session.pendingSelectionResults = flattenedOptions
  session.mode = 'awaiting_choice_global'
  return buildMultiCatalogResponse(groups, flattenedOptions, missingMedicines)
} else {
  // SINGLE-MEDICINE (línea 3267)
  searchMedicinesByName(singleQuery, { recipeMode, strictConsultationMode, ... })
  return buildCatalogResponse(result)
}
```

---

## 7. searchMedicinesByName (3337) — Scoring y matching

### Parámetros clave
```javascript
const strictReferenceThreshold = recipeMode ? 0.96 : (strictListMode ? (_singleTokenQuery ? 0.80 : 0.93) : 0.88);
```

| Query | Mode | Threshold |
|---|---|---|
| "bumetin" (single token) | `strictListMode=true, recipeMode=false` | **0.80** |
| "bumetin" (single token) | `recipeMode=true` | **0.96** |
| Multi-token ("MODERAN SUSP") | `strictListMode=true` | **0.93** |

### consultationGate filter (línea ~3816)
Solo corre cuando `consultationMode=true` **Y** `recipeMode=false`.

```javascript
if (consultationMode && primaryTokens.length > 0 && !recipeMode) {
  const q = primaryTokens[0];
  // Filter: item.tokenSet.has(q) || item.productTitleFull.toLowerCase().includes(q)
  //         || item.titleArrayTextFull.toLowerCase().includes(q)
  //         || item.ingredient.toLowerCase().includes(q)
  // ⚠️ IMPORTANTE: .includes() con case-INSENSITIVE (toLowerCase())
  //   "bumetin".includes("BUMETIN RETADAR") → FALSE (case-sensitive JS!)
  //   "bumetin".toLowerCase().includes("bumetin") → TRUE
}
```

**Bug conocido:** `"BUMETIN RETADAR 300 MG".includes("bumetin")` es **FALSE** en JavaScript porque `includes()` es case-sensitive. El fix: `.toLowerCase().includes()`.

---

## 8. Session State — Lectura crítica antes de modificar

```javascript
session.userCity         // string | null — ciudad del usuario
session.userCoords      // {lat, lng} | null
session.mode            // 'idle' | 'awaiting_choice' | 'awaiting_choice_global' | 'awaiting_product_name'
session.pendingSelectionResults  // options[] del catálogo activo
session.pendingRecipeMedicines   // medicines[] de receta OCR (guardadas en OCR block)
session.pendingCityRetry         // {text, context} de búsqueda pendiente
session.lastSearch               // último grupo de resultados
session.cart                     // carrito de selección
session.catalogSnapshot          // snapshot para "ver lista anterior"
session.catalogHistory           // historial de selecciones
```

**Regla:** после guardar `pendingRecipeMedicines` → el OCR block hace `return`. Si no hace return, el signal block lo reutiliza en el mensaje de follow-up.

---

## 9. Known pitfalls — No romper这些

### 9.1 No mover `hasOcrText` después del city gate
Si se mueve la definición de `hasOcrText` a una línea > 1811, el city gate que lo referencia genera `ReferenceError`. **Sempre definir al inicio de `routeMessage`.**

### 9.2 No cambiar el orden de bloques en `routeMessage`
El OCR block (2128) DEBE correr después del city gate (1811). Si se mueve arriba, el `&& !hasOcrText` no tiene efecto porque `hasOcrText` aún no está definido.

### 9.3 `ocrOnly=true` no evita el multi-medicine loop
`ocrOnly` solo cambia `strictListMode = false` en `searchMedicinesByName`. NO evita que el loop multi-medicina corra. Para guardar las medicines en session, el OCR block guarda `session.pendingRecipeMedicines` explícitamente.

### 9.4 El city gate con `pendingCityRetry` hace llamada recursiva
```javascript
return await routeMessage(phone, pending.text, session, pending.context);
```
Esto reinserta el texto pendiente con el `context` original (que puede tener `hasOcrText=true`). Por eso **el consume de `context.hasOcrText` al inicio de `routeMessage` es crítico** — evita que el retry re-entre al OCR block.

### 9.5 `isRecipeMode` vs `recipeMode` — No confundir
- `recipeMode` (local, línea 3089): calculado como `ocrOnly || options.recipeMode || ...`
- `isRecipeMode` (en `buildCatalogSignal`): referencia `session.isRecipeMode`

### 9.6 `consultationGate` requiere `recipeMode=false`
El filter solo se activa cuando `consultationMode=true` Y `recipeMode=false`. En modo receta (`recipeMode=true`), este filter se salta completamente.

---

## 10. Flags de debug — Dónde buscar

| Log tag | Qué buscar |
|---|---|
| `[ROUTE]` | Entrada a routeMessage — muestra `hasOcrText` |
| `[CITY-GATE]` | Decisiones del city gate |
| `[OCR medicines extraction]` | Medicines extraídas de receta OCR |
| `[OCR-REUSE]` | Reutilización de pendingRecipeMedicines |
| `[CANDIDATE-MEDICINES]` | Lista final de medicines candidatas |
| `[SEARCH-KICK]` | Cada medicine individual en el multi-loop |
| `[FIREBASE-RECIPE-DBG]` | Scores de similaridad y `recipeMode` |
| `[CONSULTATION-GATE]` | BEFORE/AFTER del filter y `recipeMode` |
| `[DEGRADED-FALLBACK]` | Matching degradado cuando Firebase da <3 |
| `[MEDICINE-RESULT]` | Resultado final por medicine |

---

## 11. Extractor functions — Dónde viven

| Función | Línea | Qué hace |
|---|---|---|
| `extractRecipeMedicineLines` | 6013 | Convierte texto de receta en líneas de medicine |
| `extractMedicineQuery` | 6612 | Extrae nombre de medicine de texto libre |
| `extractStrictConsultationMedicineQuery` | 6825 | Modo consulta estrict |
| `extractMedicineRequests` | 4716 | Extrae medicines de texto con "x" (x15, x30) |
| `extractMedicineRequestsFromSegments` | 5009 | Similar, sobre segmentos |
| `extractMedicinesWithLLMFallback` | 1507 | Usa LLM como fallback |
| `looksLikeMedicineName` | 6533 | Heurístico: ¿parece nombre de medicine? |

---

## 12. Testing checklist después de un fix

Antes de hacer commit de cualquier fix en `server.js`:

- [ ] `node --check server.js` pasa sin errores
- [ ] `hasOcrText` sigue definido al inicio de `routeMessage` (línea < 1800)
- [ ] El city gate condition sigue siendo `&& !hasOcrText`
- [ ] El OCR block sigue siendo `if (hasOcrText)` (después de línea 2000)
- [ ] `session.pendingRecipeMedicines` se guarda ANTES del return del OCR block
- [ ] `context.hasOcrText = false` consume el flag al inicio de `routeMessage`
- [ ] `buildMultiCatalogResponse` / `buildCatalogResponse` no se rompieron
- [ ] Probar flujo completo con receta OCR (imagen + "Ciudad Bolívar")
- [ ] Probar flujo de consulta normal ("Candesartan 32mg")
- [ ] Probar selección de opciones ("1", "2 x 2")
- [ ] Verificar que `MODIFIER-PENALTY` no inunde los logs

---

## 13. Glosario de modes de session

| Mode | Significado | Respuesta esperada |
|---|---|---|
| `idle` | Sin estado pendiente | Búsqueda nueva |
| `awaiting_choice` | Catálogo activo, esperando selección | Número de opción |
| `awaiting_choice_global` | Catálogo multi-medicina activo | Número de opción |
| `awaiting_product_name` | Esperando nombre de medicamento | Nombre de medicine |
