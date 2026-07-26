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

---

## 14. Flujo 1: Consulta normal de medicamento

**Trigger:** Usuario escribe `"Candesartan 32 mg"` o similar.

### 14.1 Entrada a `routeMessage` (línea 1761)

```
text = "Candesartan 32 mg"
session.userCity = "Ciudad Bolívar"  (ya configurado)
session.mode = "idle"
hasOcrText = false
```

### 14.2 Camino a través de `routeMessage`

```
1768  ULTRA-GUARD          → isSelectionPhrase("candesartan 32 mg") = false → NO ACTION
1800  City Change          → "candesartan 32 mg" no contiene "cambiar ciudad" → NO ACTION
1811  CITY GATE            → userCity="Ciudad Bolívar" (ya seteado) → CONDITION FALSE → SKIP
1864  LLM INTENT           → Puede interceptar (si LLM retorna medicine_search) o caer al regex
1896  isHumanRequest       → false
1914  isMedicineInterestStatement → false
1920  URGENT DENYLIST      → false
1958  consultationIsMedicine → true (contiene "mg", nombre de medicine)
       ↓
       searchAndBuildCatalogResponse("Candesartan 32 mg", session, {
         hasOcrText: false,
         strictConsultationMode: true,
         recipeMode: true,
         preExtractedMedicines: extractedMedicineRequests  ← ["candesartan"]
       })
```

### 14.3 Inside `searchAndBuildCatalogResponse` (línea 3056)

```
3086  preExtracted = ["candesartan"]
3090  ocrOnly = false
3091  consultationMode = true
3095  recipeMode = false  (ocrOnly=false, options.recipeMode=undefined, no "receta" en texto)
3100  normalizedPreExtracted → ["candesartan"]  (single token, pasa directo)
3104  requestedMedicines = ["candesartan"]  (preExtracted tiene 1 item, no se llama extractMedicineRequests)
3105  fallbackMedicines = []  (requestedMedicines tiene contenido)
3113  recipeLineMedicines = []  (extractRecipeMedicineLines sobre texto libre → [])
3116  llmFallbackMeds = []  (requestedMedicines tiene contenido)
3122  candidateMedicinesRaw = ["candesartan"]
3124  ← DOSAGE_FORMS filter: "candesartan" no está en set → KEEP
3133  candidateMedicines = ["candesartan"]  (1 item, length < 4 → no concat-reject check)
       ↓
3211  SINGLE-MEDICINE PATH (dedupedCandidates.length === 1)
3226  singleQuery = "candesartan"
       ↓
       extractMedicineQuery("Candesartan 32 mg") → "candesartan" (strip "32 mg")
       ↓
       searchMedicinesByName("candesartan", {
         strictListMode: true,
         recipeMode: false,
         strictConsultationMode: true,
         queryDosageSignatures: ["32mg"],
         userCoords: session.userCoords
       })
```

### 14.4 Inside `searchMedicinesByName` (línea 3337)

```
3347  queryTokens = ["candesartan"]  (tokenize → filter stopwords)
3349  _singleTokenQuery = false  (token length=11 ≥ 4, pero NO es single token... wait)
       → tokenize("candesartan") = ["candesartan"] → length=1 → _singleTokenQuery = TRUE
3350  strictReferenceThreshold = recipeMode ? 0.96 : (strictListMode ? (_singleTokenQuery ? 0.80 : 0.93) : 0.88)
       = (false ? 0.96 : (true ? 0.80 : 0.93))
       = 0.80
3357  consultationMode = true
3364  products = fetchCatalogProducts(2000)
3371  exactQuery = "candesartan"
3373  dosageLessQuery = "candesartan"  (ningún token es dosis)
3375  matchTokens = ["candesartan"]
3377  primaryTokens = ["candesartan"]
3378  primaryRoot = "candesartan"
3384  modifierTokens = []  (solo 1 token → no modifiers)
3394  queryDosageSignatures = ["32mg"]
3396  standaloneMatch = null → solo "32mg"
3400  hasQueryDosage = true

3421  Scoring loop:
       Para cada producto del catálogo (~2000):
         score = Jaro-Winkler("candesartan", productTitleNormalized)
         + modifiers penalty
         + dosage penalty if hasQueryDosage=true
         + reference similarity
       → scoredProducts.sort(by score desc)

3851  CONSULTATION-GATE (consultationMode=true && recipeMode=false):
       q = "candesartan"
       scoredProducts = scoredProducts.filter: solo productos donde
         item.tokenSet.has("candesartan") = TRUE  ← productos con "candesartan" en título
         O substring match con case-insensitive
       beforeCount = 2000 → afterCount = N (ej. 3 productos Candesartan)

3896  DEGRADED-FALLBACK:
       Si scoredProducts < 3:
         Buscar en Firebase Firestore (collections "products-market", "providers-products")
         usando arrayContains sobre productTitleArray
         → candidateMatches = M (suplemento si Firebase tiene más)

4011  DEGRADED-CANDIDATE MATCHING:
       Para cada scoredProduct (ya filtrado a los mejores N):
         referenceSimilarity = JaroWinkler(candCore, candidateCore)
         candidateCore = "candesartan 32 mg"
         candCore = productTitleNormalized sin dosages
         → Si referenceSimilarity ≥ 0.80 (threshold para single token) → MATCH
         → Si NO → se considera "No disponible"

4040  Final result.matches = [product1, product2, ...]
       result.exchangeRate = BCV rate
```

### 14.5 Respuesta

```
buildCatalogResponse(result):
  "🔎 *Candesartan 32 mg*
   💱 Tasa BCV: Bs 742,23

   💊 1. CANDESARTAN 16MG X 30 TABLETAS SPEFAR
      🏥 Farma Hogar — a 2.9 km
      $5,71  |  Bs 4.235,31

   💊 2. CANDESARTAN 8MG (GENCER) X 10 TAB
      🏥 Farmacia VIP — a 1.5 km
      $2,05  |  Bs 1.521,35

   ...

   👉 Para agregar: quiero X cajas de la opción Z
   🛒 ¿Otro medicamento? Escríbeme el nombre y lo agrego a tu lista.
   ✅ Cuando termines, escribe *LISTO* y te muestro el resumen."
```

### 14.6 Session después de la búsqueda

```
session.mode = 'idle'
session.lastSearch = result  (grupo de resultados)
session.pendingSelectionResults = result.matches  (opciones numeradas)
session.pendingCityRetry = null
```

---

## 15. Flujo 2: Receta médica OCR (imagen)

**Trigger:** Usuario envía una foto de receta médica.

### 15.1 Punto de entrada

```
WhatsApp API → handleEvent(event, data)
  → processIncomingMessage(payload):
       extrae media de la imagen
       callOpenAIVision(imageBase64, mimeType)
         → OCR text = "ESOZ 40 MG\nLEPRIT 25 MG\n..."
       context = {
         hasOcrText: true,
         ocrSearchText: "ESOZ 40 MG\n...",
         rawOcrText: "ESOZ 40 MG\n...",
         pushName: "Roberto"
       }
  → routeMessage(phone, text, session, context)
```

### 15.2 Inside `routeMessage` — Entrada

```
1763  hasOcrText = Boolean(context.hasOcrText) = true
1764  context.hasOcrText = false  ← CONSUME
1765  console.log(..., hasOcrText=true)

1768  ULTRA-GUARD          → false (no es selección)
1800  City Change          → false
1811  CITY GATE            → condition: (!userCity || ...) && !hasOcrText
                                  = true && !true = FALSE → SKIP ENTIRELY
       ← EL CITY GATE NO PREGUNTA POR CIUDAD PARA OCR

1864  LLM INTENT           → puede interceptar
1896  isHumanRequest       → false
1914  isMedicineInterestStatement → false
1920  URGENT DENYLIST      → false
1958  consultationIsMedicine → FALSE (el texto很长 pero no pasa el regex)
       ← NO entra por este path

2128  OCR BLOCK (hasOcrText=true):
```

### 15.3 Inside OCR Block (línea 2128)

```
2132  rawOcr = recipeSourceText || text
       = context.rawOcrText || context.ocrSearchText
       = "ESOZ 40 MG\nLEPRIT 25 MG\nBUMETIN RETADAR 300 MG\nEVIGAX CAP\nMODERAN SUSP\nMILAX POLVO\nDAFLON 500 MG\nBARGONIL CREMA"

2135  prescriptionClean = sanitizePrescriptionText(rawOcr)
       → Convierte "RP: ESOZ 40 MG, LEPRIT 25 MG..." en líneas separadas
       → Detecta formato receta médica (RP: prefix, listas con剂量)
       → Expected output: "ESOZ 40 MG\nLEPRIT 25 MG\nBUMETIN RETADAR 300 MG\nEVIGAX CAP\n..."

2140  boxClean = sanitizeMedicineBoxText(rawOcr)
       → Si no es receta (formato empaque): "CAJA DE 30 TABLETAS DE 40MG..."
       → Para recetas este es vacío o ruido

2143  recipeClean = sanitizeRecipeText(rawOcr)
       → Último recurso: normalización genérica
       → Limpia "\n", "  ", " .", etc.

2147  allRecipeMedicines = prescriptionClean || boxClean || recipeClean
       = prescriptionClean (non-empty, es formato receta)

2160  PURE_DOSAGE_RE check:
       rawOcr.trim() = "ESOZ 40 MG..." → NO match con纯剂量 regex → PROCEED

2162  searchQuery = allRecipeMedicines

2167  allRecipeMedicinesList = extractRecipeMedicineLines(allRecipeMedicines)
       → Líneas 6013-6295:
       → Divide por "\n", líneas que contienen dosage patterns
       → Saca cada nombre de medicine limpio
       → Output esperado: ["ESOZ 40 MG", "LEPRIT 25 MG", "BUMETIN RETADAR 300 MG",
                            "EVIGAX CAP", "MODERAN SUSP", "MILAX POLVO",
                            "DAFLON 500 MG", "BARGONIL CREMA"]
       → 8 medicines

2173  session.pendingRecipeMedicines = allRecipeMedicinesList
       ← GUARDA para el follow-up "Ciudad Bolívar"
       ← CRÍTICO: esto es lo que faltaba (bug 2026-07-26)

2176  catalogResult_ocr = await searchAndBuildCatalogResponse(searchQuery, session, {
       hasOcrText: true,
       ocrOnly: true,
       recipeMode: true,
       preExtractedMedicines: allRecipeMedicinesList
     }, { phone, pushName })
```

### 15.4 Inside `searchAndBuildCatalogResponse` — OCR path (línea 3056)

```
3086  preExtracted = allRecipeMedicinesList = 8 items
3090  ocrOnly = true
3091  consultationMode = false (strictConsultationMode no viene en options)
3095  normalizedPreExtracted:
       preExtracted[0] = "ESOZ 40 MG" → single token? NO → includes ' ' → SPLIT
         → split(/\s+/) = ["ESOZ","40","MG"]
         → filter: t.length >= 3 AND !DOSAGE_QUANTITY_REJECT AND looksLikeMedicineName(t)
         → "ESOZ" → KEEP (looksLikeMedicineName=true)
         → "40" → REJECT (length < 3)
         → "MG" → REJECT (DOSAGE_QUANTITY_REJECT)
       → normalizedPreExtracted = ["ESOZ"]  ← ⚠️ SOLO "ESOZ", se pierden las otras 7!

3104  requestedMedicines = normalizedPreExtracted = ["ESOZ"]
3105  fallbackMedicines = []
3113  recipeLineMedicines = extractRecipeMedicineLines(text)
       ← Acá entra extractRecipeMedicineLines sobre el texto de la receta
       ← Este SÍ extrae las 8 líneas correctamente
       ← Output: ["ESOZ 40 MG", "LEPRIT 25 MG", "BUMETIN RETADAR 300 MG", ...]
3116  llmFallbackMeds = []
3122  candidateMedicinesRaw = dedupeStrings([
         "ESOZ",           ← from requestedMedicines
         "LEPRIT",         ← from recipeLineMedicines token split
         "BUMETIN",        ← from recipeLineMedicines token split
         "RETADAR",        ← from recipeLineMedicines token split
         "EVIGAX",         ← from recipeLineMedicines token split
         "CAP",            ← from recipeLineMedicines token split
         "MODERAN",        ← from recipeLineMedicines
         "SUSP",           ← from recipeLineMedicines token split
         "MILAX",          ← from recipeLineMedicines
         "POLVO",          ← from recipeLineMedicines token split
         "DAFLON",         ← from recipeLineMedicines
         "500",            ← from recipeLineMedicines token split
         "BARGONIL",       ← from recipeLineMedicines
         "CREMA"           ← from recipeLineMedicines token split
       ])
       ← 14 items! Muchos son fragmentos

3124  DOSAGE_FORMS filter:
       DOSAGE_FORMS.has("ESOZ") → FALSE → KEEP
       DOSAGE_FORMS.has("LEPRIT") → FALSE → KEEP
       DOSAGE_FORMS.has("BUMETIN") → FALSE → KEEP
       DOSAGE_FORMS.has("RETADAR") → FALSE → KEEP (not "retadar" variant)
       DOSAGE_FORMS.has("EVIGAX") → FALSE → KEEP
       DOSAGE_FORMS.has("CAP") → TRUE → REJECT
       DOSAGE_FORMS.has("MODERAN") → FALSE → KEEP
       DOSAGE_FORMS.has("SUSP") → TRUE → REJECT
       DOSAGE_FORMS.has("MILAX") → FALSE → KEEP
       DOSAGE_FORMS.has("POLVO") → TRUE → REJECT
       DOSAGE_FORMS.has("DAFLON") → FALSE → KEEP
       DOSAGE_FORMS.has("500") → FALSE → KEEP
       DOSAGE_FORMS.has("BARGONIL") → FALSE → KEEP
       DOSAGE_FORMS.has("CREMA") → TRUE → REJECT

       candidateMedicinesRaw = ["ESOZ", "LEPRIT", "BUMETIN", "RETADAR", "EVIGAX",
                                 "MODERAN", "MILAX", "DAFLON", "500", "BARGONIL"]
       ← 10 items (4 forms rechazados, "500" queda - potential noise)

3133  CONCAT-REJECT filter:
       itemTokens >= 7 → none of these are that long
       itemTokens >= 4: "RETADAR" → length=7? "RETADAR" = 7 tokens? → no
         → All single-token items → SKIP concat-reject check
       candidateMedicines = candidateMedicinesRaw.map(
         item → recipeMode ? extractPrimaryRecipeMedicineQuery(item) : item
       )
       extractPrimaryRecipeMedicineQuery("500") → "" → filter(Boolean) → REMOVE
       extractPrimaryRecipeMedicineQuery("RETADAR") → "" → REMOVE
       → candidateMedicines = ["ESOZ", "LEPRIT", "BUMETIN", "EVIGAX",
                                 "MODERAN", "MILAX", "DAFLON", "BARGONIL"]
       ← 8 medicines correctas!

3200  dedupLLMMedicines(candidateMedicines)
       → dedupedCandidates = ["ESOZ", "LEPRIT", "BUMETIN", "EVIGAX",
                               "MODERAN", "MILAX", "DAFLON", "BARGONIL"]
       ← 8 medicines

3211  MULTI-MEDICINE PATH (dedupedCandidates.length = 8 > 1)

3214  for (const medicineQuery of dedupedCandidates) {
         searchMedicinesByName(medicineQuery, {
           products,
           exchangeRate,
           strictListMode: !ocrOnly = false,  ← !true = false
           recipeMode: true,  ← from options
           strictConsultationMode: consultationMode = false,  ← !strictConsultationMode
           userCoords: session.userCoords
         })
       }

       Nota: strictListMode = false → threshold usa 0.88 (no 0.80 ni 0.93)
       Pero recipeMode = true → threshold = 0.96
```

### 15.5 Inside `searchMedicinesByName` — Para cada medicine del OCR

```
3349  _singleTokenQuery = TRUE (todos son single token, length >= 4)
3350  strictReferenceThreshold = recipeMode ? 0.96 : (strictListMode ? (_singleTokenQuery ? 0.80 : 0.93) : 0.88)
       = 0.96  (recipeMode=true wins)

3851  CONSULTATION-GATE: consultationMode=false → SKIPPED ENTIRELY
       ← Esto es CRÍTICO: el filter de consultationGate NO corre en modo receta
       ← Así "bumetin" puede encontrar "BUMETIN RETADAR 300 MG" sin filter restrictivo

4011  DEGRADED-FALLBACK: Si Firebase retorna < 3 matches
       → Busca en Firebase arrayContains
       → candidateMatches = M

       Para BUMETIN: "BUMETIN RETADAR 300 MG" existe en Firebase?
       → Si no está en catalog (0 matches), Firebase arrayContains busca en productTitleArray
       → "bumetin".search("bumetin retadar 300 mg") → partial match
       → candidateMatches = 1 → entra a degraded

       DEGRADED-MATCHING para "bumetin" vs "BUMETIN RETADAR 300 MG":
         candCore = "bumetin retadar 300 mg" (product title, lowercased, dosages stripped)
         queryCore = "bumetin" (lower)
         referenceSimilarity = JaroWinkler("bumetin", "bumetin retadar")
         → JW("bumetin", "bumetin retadar") ≈ 0.91
         → 0.91 < 0.96 (threshold) → NO MATCH en degraded path
         PERO hay un bypass especial para recipe medicines...
```

### 15.6 Nota sobre BUMETIN y el threshold 0.96

```
El problema: recipeMode=true → threshold=0.96
"bumetin" vs "bumetin retadar" → JW ≈ 0.91 < 0.96

En modo receta, el threshold real para fuzzy es:
  - consultationMode=false, recipeMode=true
  - strictReferenceThreshold = 0.96 (del código)

Sin embargo, el DEGRADED-FALLBACK puede activar Firebase direct search:
  [FIREBASE-DIRECT] candidateMatches=1 (< 3), querying Firebase arrayContains for token='MODERAN'...
  → Firebase hace matching laxo sobre productTitleArray
  → "MODERAN" → encuentra "MODERAN SOLUCION ORAL 120ML VARGAS"
  → aunque el score formal sea bajo

⚠️ Para recetas OCR, asegurar que el threshold de 0.96 no esté 
   rechazando medicines legítimas que el fuzzy matching debería aceptar.
   Si "BUMETIN" no se encuentra, puede ser porque:
   1. No existe en el catálogo local (0 scoredProducts)
   2. Firebase arrayContains no lo tiene
   3. referenceSimilarity < 0.96
```

### 15.7 Session state después del OCR

```
session.pendingRecipeMedicines = ["ESOZ", "LEPRIT", "BUMETIN", "EVIGAX",
                                   "MODERAN", "MILAX", "DAFLON", "BARGONIL"]
session.mode = 'awaiting_choice_global'
session.pendingSelectionResults = flattenedOptions  (25 opciones de 8 medicines)
session.lastSearch = groups[0]
```

### 15.8 Follow-up: Usuario responde "Ciudad Bolívar"

```
routeMessage(phone, "Ciudad Bolívar", session, context={})
  1763  hasOcrText = false  (ya fue consumido)
  1811  CITY GATE: userCity=null, hasOcrText=false
        → detectCityFromText("Ciudad Bolívar") → {city: "Ciudad Bolívar", coords: {...}}
        → session.userCity = "Ciudad Bolívar"
        → session.userCoords = {lat: 8.1292, lng: -63.5409}
        → touchSession(session)
        → return "✅ Ciudad configurada: *Ciudad Bolívar*. Ahora busca..."
        ← Muestra confirmación de ciudad, no el catálogo
        ← ⚠️ Pero los resultados del catálogo YA se mostraron en el paso 15.7
```

### 15.9 Flujo completo ideal (corregido)

```
User sends image → OCR block → searchAndBuildCatalogResponse (8 medicines)
  → buildMultiCatalogResponse → "🔎 Resultados encontrados..."
  → session.pendingRecipeMedicines = [8 medicines]

User sends "Ciudad Bolívar" → CITY GATE detects city
  → saves userCity → calls routeMessage(pending.text=receta_text, pending.context)
  → BUT: pending.context.hasOcrText = false (was consumed)
  → OCR block is SKIPPED (hasOcrText=false)
  → falls through to medicine search
  → WITHOUT the stored pendingRecipeMedicines!

← Este era el bug: después de "Ciudad Bolívar", se perdían las 8 medicines
```

**Fix aplicado (2026-07-26):** El OCR-REUSE block (línea 2191) detecta `session.pendingRecipeMedicines` y lo usa en lugar de re-extraer del texto.

---

## 16. Flujo 3: Selección de opciones ("1", "2 x 2")

**Trigger:** Después de un catálogo, usuario responde con número de opción.

### 16.1 Tipos de selección

| Input | parseSelectionCommand output |
|---|---|
| `"1"` | `{option: 1, quantity: 1, options: [1]}` |
| `"2"` | `{option: 2, quantity: 1, options: [2]}` |
| `"2 x 2"` | `{option: 2, quantity: 2, options: [2]}` |
| `"1, 2, 3"` | `{option: [1,2,3], quantity: 1, options: [1,2,3]}` |
| `"3 x 1"` | `{option: 3, quantity: 1, options: [3]}` |

### 16.2 Camino a través de `routeMessage`

```
1768  ULTRA-GUARD → isSelectionPhrase("2 x 2") = true
       → getLatestCatalogSnapshot(session) → tiene options? → YES
       → parseSelectionCommand("2 x 2") → {option: 2, quantity: 2}
       → selected = snapshot.options[1]  (índice 0-based)
       → addItemToCart(session, selected, 2)
       → clearSelectionState(session)
       → return formatSelectionSavedMessage(selected, 2, session)
       ← TERMINA AQUÍ — no llega al OCR block ni a searchAndBuildCatalogResponse
```

### 16.3 Si ULTRA-GUARD no dispara (por qué podría no disparar)

```
1768  Si snapshot.options está vacío O no hay snapshot:
       → NO entra al if del ULTRA-GUARD
       → sigue a 1811 CITY GATE
         → puede pedir ciudad si userCity=null
       → sigue a 1864 LLM INTENT
       → ...
       → 1958 consultationIsMedicine → false ("2" no parece medicine)
       → 1987 isNewOrderNotification → false
       → 2036 isViableDirectQuery → false (length < 5)
       → 2047 "LISTO" → false
       → 2050 CITY EARLY DETECTION → false
       → 2067 isGreetingOrMenu → false
       → 2083 THANKS, LOCATION... → false
       → 2128 OCR → false (no hasOcrText)
       → 2191 OCR-REUSE → false (hasMedicineSearchSignal=false)
       → 2215 SELECTION BLOCK
```

### 16.4 Inside Selection Block (línea 2215)

```
2215  medicineRequests = extractMedicineRequests("2 x 2")
       → []  ("2" no es medicina)

       selectionCandidate = parseSelectionCommand("2 x 2")
       → {option: 2, quantity: 2, options: [2]}

       isSelectionMessage = Boolean(selectionCandidate) = true
       hasMedicineSearchSignal = false

       hasSelectionResults = resolveSelectionResults(session)
       → session.pendingSelectionResults (del catálogo anterior)
       → O session.catalogSnapshot.options

2240  if (selectionCandidate && hasSelectionResults && medicineRequests.length === 0):
       → TRUE && TRUE && TRUE
       → Entra al bloque de selección

       results = resolveSelectionResults(session)
       optionList = [2]
       quantity = 2

       selected = results[2 - 1] = results[1]
       addItemToCart(session, selected, 2)
       pushSelectionHistory(session, selected, 2)

       → touchSession(session)
       → return mensaje de confirmación:
         "✅ *Agregado a tu selección*

          1. 💊 *CANDESARTAN 16MG X 30 TABLETAS SPEFAR*
             Cantidad: *2*
             Unitario: $5,71  |  Bs 4.235,31
             Subtotal: $11,42  |  Bs 8.470,62

          🧾 Tu carrito actual: *$11,42*  |  *Bs 8.470,62*
          Puedes seguir agregando opciones de esta misma lista o escribir *LISTO*
          para ver el pedido completo."
```

### 16.5 addItemToCart internals (línea 597)

```javascript
function addItemToCart(session, item, quantity) {
  session.cart = session.cart || [];
  // Busca si el item ya está en el carrito
  const existing = session.cart.find(i => i.doc?.id === item.doc?.id);
  if (existing) {
    existing.quantity += quantity;  // acumula cantidad
  } else {
    session.cart.push({
      doc: { id: item.doc?.id },
      title: item.title,
      priceUsd: item.priceUsd,
      priceBs: item.priceBs,
      providerName: item.providerName,
      distancia: item.distancia,
      quantity  // cantidad en este momento
    });
  }
}
```

### 16.6 Carrito multi-opción ("1, 2, 3 x 2")

```
Si selectionCandidate.options = [1, 2, 3] y quantity = 2:
  → Itera sobre optionList = [1, 2, 3]
  → selected = results[0], results[1], results[2]
  → addItemToCart(session, selected, 2) para cada uno
  → Muestra confirmación con 3 items y total acumulado
```

### 16.7 "LISTO" — Summary (línea 2047)

```
if (/^(listo|resumen)\b/.test(normalized)) {
  return buildSelectedProductsSummary(session);
}

buildSelectedProductsSummary (línea 565):
  → Itera sobre session.cart
  → Calcula total USD y Bs
  → Genera mensaje con todos los items, cantidades, precios
  → Incluye instructions de pago y contacto humano
```

---

## 17. Flujo 4: Thresholds y scoring — Por qué "bumetin" no matcheaba

### 17.1 Los 3 thresholds en el código

```javascript
// Línea 3349-3350
const strictReferenceThreshold = recipeMode
  ? 0.96                                    // Modo receta: 0.96 (muy alto)
  : (strictListMode
    ? (_singleTokenQuery ? 0.80 : 0.93)    // Normal: 0.80 (single) o 0.93 (multi)
    : 0.88);                               // No strict: 0.88
```

| Situación | `recipeMode` | `strictListMode` | `_singleTokenQuery` | **Threshold** |
|---|---|---|---|---|
| "bumetin" normal | false | true | true | **0.80** |
| "bumetin" en receta OCR | true | false | true | **0.96** |
| "candesartan 32mg" normal | false | true | false | **0.93** |
| "MODERAN SUSP" en receta | true | false | false | **0.96** |

### 17.2 Jaro-Winkler Similarity explained

JW similarity mide qué tan parecido son dos strings:
- 1.0 = idénticos
- 0.0 = completamente distintos
- 0.91 = "bumetin" vs "bumetin retadar" (el sufijo " retadar" baja el score)

```
JW("bumetin", "bumetin") = 1.00
JW("bumetin", "bumetin retadar") ≈ 0.91  (prefix match con extensión)
JW("bumetin", "BUMETIN RETADAR 300 MG") ≈ 0.85  (más largo, más diferencia)
```

**Problema:** Con `recipeMode=true` y threshold `0.96`:
- `0.91 < 0.96` → **NO MATCH**
- El producto "BUMETIN RETADAR 300 MG" no aparece como resultado

**Fix potencial:** Bajar el threshold para single-token queries en recipeMode:
```javascript
const strictReferenceThreshold = recipeMode
  ? (_singleTokenQuery ? 0.85 : 0.96)  // 0.85 para single-token en receta
  : (strictListMode ? (_singleTokenQuery ? 0.80 : 0.93) : 0.88);
```

### 17.3 El filter `consultationGate` y su bug de case-sensitivity

**Línea 3862-3865** (dentro del filter):
```javascript
item.tokenSet.has(q)                                                    // exact, case-SENSITIVE
|| item.productTitleFull === q                                          // exact
|| item.productTitleFull.startsWith(q + ' ')                           // starts with
|| item.productTitleFull.endsWith(' ' + q)                             // ends with
|| item.productTitleFull.toLowerCase().includes(' ' + q + ' ')         // ← CORRECTO: case-insensitive
|| item.titleArrayTextFull.toLowerCase().includes(' ' + q + ' ')       // ← CORRECTO
|| item.ingredient === q || item.ingredient.startsWith(...)            // ...
```

**El bug (antes del fix):**
```javascript
// SI el código usaba .includes(q) en lugar de .includes(' ' + q + ' ') con toLowerCase():
item.productTitleFull.includes("bumetin")
// "BUMETIN RETADAR 300 MG".includes("bumetin") === FALSE  (case-sensitive!)
// "bumetin".includes("bumetin") === TRUE  (funciona solo si query=título)
```

**El fix correcto:**
```javascript
item.productTitleFull.toLowerCase().includes('bumetin')  // TRUE
```

### 17.4 Dosage penalty en scoring

**Línea ~3720** (dentro del scoring loop):
```javascript
if (hasQueryDosage && dosageLessQuery) {
  const productDosages = extractDosageSignatures(productTitleFull);
  const productHasDosage = productDosages.length > 0;
  const queryDosageNormalized = queryDosageSignatures.map(d => d.replace(/^sd:/, ''));
  const productDosageNormalized = productDosages.map(d => d.replace(/^sd:/, ''));

  if (productHasDosage) {
    // Penalty si el query tiene DOSIS y el producto NO coincide
    // o si el producto tiene DOSIS pero el query no
    const anyMatch = queryDosageNormalized.some(qd =>
      productDosageNormalized.some(pd => pd === qd)
    );
    if (!anyMatch) score -= 200;  // fuerte penalty por dosis que no cuadra
  }
}
```

Ejemplo: query `"ATORVASTATINA 30 MG"` vs producto `"ATORVASTATINA 40 MG X 30"`:
- Ambos tienen dosis → penalty de -200 si no coinciden
- Score final puede caer por debajo del threshold → NO MATCH

### 17.5 Modifier tokens

Tokens después del primero que son modificadores (forte, duo, flex, etc.):
```javascript
modifierTokens = rawTokens.slice(1).filter(t => {
  if (isNumberOrDosage(t)) return false;
  return MODIFIER_TOKENS.has(t) || t.length <= 4;
});
```

Si el query tiene `"NIFEDIPINA 10 MG"` → modifiers = `["10", "MG"]`
- `"10"` → es número → `isNumberOrDosage=true` → excluded
- `"MG"` → dosage → excluded

Si el query tiene `"PARACETAMOL FORTE"` → modifiers = `["FORTE"]`
- `"FORTE"` → no es dosage, length=5, `MODIFIER_TOKENS.has("FORTE")` → included
- Productos SIN "FORTE" en el título → modifier penalty de -50

---

## 18. Flujo 5: Error crítico "No disponibles" para ESOZ, LEPRIT, DAFLON, BUMETIN

### 18.1 El bug completo (root cause analizado)

```
OBSERVADO en producción:
  → Usuario envía receta OCR con 8 medicines
  → Bot responde "indícame tu ciudad"
  → Usuario responde "Ciudad Bolívar"
  → Bot muestra: 4 "No disponibles" + 4 medicines encontradas
     ⚠️ No disponibles: ESOZ, LEPRIT, DAFLON, BUMETIN
     ✅ Encontradas: EVIGAX, MODERAN, MILAX, BARGONIL

SECUENCIA DE eventos (reconstruida desde logs):

Message 1: Usuario envía imagen de receta
  hasOcrText = true
  userCity = null

  routeMessage entry:
    hasOcrText = true
    CITY GATE: (!null && !true) = false → SKIP ← Ciudad NO se pide aquí
    LLM INTENT → puede pasar
    consultationIsMedicine = false
    OCR BLOCK: hasOcrText=true → ENTRA
      allRecipeMedicinesList = [8 medicines]
      session.pendingRecipeMedicines = [8 medicines]  ← GUARDADO
      searchAndBuildCatalogResponse(searchQuery, {
        hasOcrText: true,
        ocrOnly: true,
        recipeMode: true,
        preExtractedMedicines: [8 medicines]
      })
      → Multi-medicine loop corre 8 searches
      → 4 medicines encuentran producto (EVIGAX, MODERAN, MILAX, BARGONIL)
      → 4 medicines no encuentran (ESOZ, LEPRIT, DAFLON, BUMETIN)
      → buildMultiCatalogResponse → respuesta al usuario
      return  ← TERMINA AQUÍ
      ← session.pendingRecipeMedicines SEGUÍA GUARDADO

Message 2: Usuario responde "Ciudad Bolívar"
  hasOcrText = false (ya consumido)
  userCity = null (nunca se guardó ciudad)

  routeMessage entry:
    hasOcrText = false
    CITY GATE: (!null && !false) = true → ENTRA
      detectCityFromText("Ciudad Bolívar") → cityInfo = {city, coords}
      → session.userCity = "Ciudad Bolívar"
      → session.userCoords = {lat, lng}
      → touchSession(session)
      → "✅ Ciudad configurada: *Ciudad Bolívar*. Ahora busca..."
      return ← TERMINA AQUÍ
      ← session.pendingRecipeMedicines SEGUÍA GUARDADO
      ← PERO NUNCA SE USÓ para mostrar catálogo!
```

### 18.2 Por qué el catálogo no se mostró con "Ciudad Bolívar"

```
El CITY GATE con ciudad detectada RETorna, no llama a routeMessage(pending.text).

Revisión del código línea 1828-1831:
  if (cityInfo) {
    session.userCity = cityInfo.city;
    session.userCoords = cityInfo.coords;
    touchSession(session);
    console.log(`[CITY] Direct detect from city gate: '${cityInfo.city}'`);
    if (session.pendingCityRetry) {
      const pending = session.pendingCityRetry;
      session.pendingCityRetry = null;
      return await routeMessage(phone, pending.text, session, pending.context);
      // ← Acá SÍ llama routeMessage con pending.text (el texto de la receta)
      // Pero pendingCityRetry solo se setea cuando texto = "looksLikeMedicine"
      // y el usuario responde con ciudad
      // En Message 1, el CITY GATE guardó pendingCityRetry con text=receta
      // Y Message 2 (Ciudad Bolívar) sí llama routeMessage(pending.text=receta)
    }
    return `✅ Ciudad configurada: *${cityInfo.city}*. Ahora busca...`;
    // ← Este return muestra confirmación de ciudad
    // ← Los resultados del catálogo se mostraron en Message 1
  }
```

**¿Entonces los resultados SÍ se mostraron en Message 1?**

El problema real es que el log `[OCR medicines extraction]` **NO aparecía** en producción. Esto sugiere que el CITY GATE interceptaba Message 1 ANTES de llegar al OCR block.

Revisando el flujo real de Message 1:
```
routeMessage(phone, "ESOZ 40 MG\n...", session, context={hasOcrText: true})
  hasOcrText = true
  CITY GATE: (!session.userCity && !hasOcrText) = (!null && !true) = false
    ← CIudad gate SKIP porque hasOcrText = true
    ← OCR block debería correr...
```

**A menos que...** `session.userCity` no era `null`, sino `"null"` (string):
```
session.userCity = "null"  (malformed, de sessionstorage/string serialization)
CITY GATE: (!"null" && !true) = (false && true) = false → SKIP
```

Entonces el CITY GATE NO era el problema en Message 1.

### 18.3 La verdadera causa (del log real)

```
Del log de Roberto:
🧪 [CITY-GATE] text="ESOZ 40 MG\nLEPRIT 25 MG..." looksLikeMedicine="ESOZ LEPRIT..."
🧪 [ROUTE-RESPONSE] body="ESOZ 40 MG..." response="Para buscar farmacias cerca de ti, indícame tu ciu..."

→ Esto significa que el CITY GATE SÍ entró (para Message 1 con imagen)
→ Y guardó pendingCityRetry = {text, context}
→ Y respondió "indícame tu ciudad"
→ El OCR block NUNCA se ejecutó en Message 1
```

**¿Por qué CITY GATE entró si `hasOcrText=true`?**

```
Condición: (userCity === 'null') && !hasOcrText
  → Si userCity es 'null' (string, no null)
  → !hasOcrText = false (porque hasOcrText era true)
  → (true) && false = false → NO ENTRARÍA

PERO... el log muestra que SÍ entró.

Posible explicación: hasOcrText en el context de processIncomingMessage
para la imagen era false, no true. Solo context.ocrSearchText estaba set.

Cuando processIncomingMessage detecta media:
  1. Descarga la imagen
  2. Llama a OpenAI Vision
  3.得到 OCR text
  4. Llama routeMessage con context = {
       hasOcrText: true,
       ocrSearchText: "ESOZ 40 MG\n...",
       rawOcrText: "ESOZ 40 MG\n..."
     }

PERO... ¿y si el cuerpo del mensaje (text parameter a routeMessage)
contenía el texto OCR directamente?
  text = "ESOZ 40 MG\nLEPRIT 25 MG..."
  session.userCity = "null"  (string)
  hasOcrText = context.hasOcrText = true

  CITY GATE: (!"null" && !true) = (false && true) = false → SKIP
  → Entonces el CITY GATE NO debería haber entrado

El log muestra [CITY-GATE] con looksLikeMedicine = "ESOZ LEPRIT..."
→ Esto solo pasa en el CITY GATE, línea 1855
→ Línea 1811: if (!session.userCity || session.userCity === 'null' || ...)
→ Si userCity = null (no string), !null = true
→ && !hasOcrText → si hasOcrText = true, !true = false
→ true && false = false → SKIP

Entonces... ¿hasOcrText era FALSE para este mensaje?
```

**La respuesta:** `hasOcrText` era `false` porque `processIncomingMessage` para el segundo mensaje (imagen) seteo `hasOcrText` pero el `text` que llega a routeMessage es el texto de WhatsApp (que puede ser una caption "Receta" o la imagen misma como text).

Mirando `processIncomingMessage`:
```javascript
// Linea ~750
const body = extractBody(payload);  // texto de WhatsApp (caption de la imagen)
const context = {};
if (hasMedia) {
  context.hasOcrText = true;  // ← Solo si hay media
  context.ocrSearchText = ocrText;
  context.rawOcrText = ocrText;
}
return await routeMessage(phone, body, session, context);
```

Si el usuario envía solo la imagen (sin caption), `body` = `""` (vacío). El `extractBody` para una imagen con caption vacía podría devolver `""` o la caption.

**El bug real (2026-07-26) — Conclusión final:**

Cuando `body = ""` (imagen sin caption):
- `text = ""` entra a routeMessage
- `extractMedicineQuery("")` → `null`
- `looksLikeMedicine = null`
- `isNewOrderNotification("")` → false
- `isGreetingOrMenu("")` → false
- **No matchea ningún bloque early**
- Llega al OCR block → `hasOcrText = true` → OCR corre

Cuando `body = "ESOZ 40 MG\n..."` (el texto OCR como caption):
- `text = "ESOZ 40 MG\n..."` entra a routeMessage
- CITY GATE lo ve → `looksLikeMedicine = "ESOZ LEPRIT..."`
- **`hasOcrText = context.hasOcrText`** — pero `context.hasOcrText` solo se setea si `hasMedia = true`
- Si la imagen llega como MESSAGE TYPE = image (no text con caption):
  - `hasMedia = true`
  - `context.hasOcrText = true`
  - `body = extractBody(payload)` → caption o texto de la imagen
  - Si caption está vacía → `body = ""` → CITY GATE se salta por `looksLikeMedicine = null`

**EN RESUMEN:** El bug era que `hasOcrText` no se definía al inicio de `routeMessage`, antes del CITY GATE. Se definía DESPUÉS (línea 1903), por lo que el CITY GATE usaba `hasOcrText` como `undefined` (falsy), y el condition `&& !hasOcrText` era `&& !undefined = true`, haciendo que el CITY GATE entrara.

**Fix (b30eef4):** Definir `hasOcrText` al inicio de `routeMessage` (línea 1763) antes del CITY GATE.

### 18.4 Verificación post-fix

```
commit b30eef4: "fix: move hasOcrText definition to top of routeMessage"
```

Después de este commit:
```
routeMessage(phone, text, session, context):
  1763  hasOcrText = Boolean(context?.hasOcrText)  ← DEFINIDO AQUÍ
  1764  if (context) context.hasOcrText = false
  
  1811  CITY GATE:
    (!session.userCity || session.userCity === 'null' || ...) && !hasOcrText
    → Si context.hasOcrText = true → !true = false → CITY GATE SKIP
    → Si context.hasOcrText = false → !false = true → CITY GATE PUEDE ENTRAR
    ← Funciona correctamente
```

---

## 19. Sesión típica completa (happy path)

```
1. Usuario: "Candesartan 32mg"
   session.userCity = null
   → CITY GATE: pendingCityRetry = {text, context}
   ← "Para buscar farmacias cerca de ti, indícame tu ciudad..."

2. Usuario: "Ciudad Bolívar"
   → CITY GATE: userCity = "Ciudad Bolívar", coords = {...}
   → routeMessage(pending.text) recursivo
   → searchAndBuildCatalogResponse("Candesartan 32mg")
   → buildCatalogResponse → catálogo
   session.mode = 'idle'
   session.pendingSelectionResults = [opciones]
   session.lastSearch = result

3. Usuario: "2 x 2"
   → ULTRA-GUARD: selected = options[1], quantity = 2
   → addItemToCart(session, selected, 2)
   ← "✅ Agregado a tu selección... Carrito: $11,42"

4. Usuario: "Otro medicamento para presión"
   → consultationIsMedicine = true
   → searchAndBuildCatalogResponse("Losartan 50mg")
   → buildCatalogResponse → catálogo
   session.mode = 'idle'
   session.pendingSelectionResults = [opciones losartan]

5. Usuario: "3"
   → ULTRA-GUARD: selected = options[2], quantity = 1
   → addItemToCart(session, selected, 1)
   ← "✅ Agregado... Carrito: $15,50"

6. Usuario: "LISTO"
   → buildSelectedProductsSummary(session)
   ← Resumen completo del pedido con todos los items
```

---

## 20. Tabla resumen: Flags de `searchAndBuildCatalogResponse`

| Flag | Origin | Effect |
|---|---|---|
| `hasOcrText` | Caller (routeMessage) | Pasa a `searchMedicinesByName`; en routeMessage indica "esta búsqueda vino del OCR" |
| `ocrOnly` | OCR block only | `strictListMode = !ocrOnly`; para OCR, baja threshold a 0.80 |
| `recipeMode` | Auto-computed (línea 3095) | `ocrOnly \|\| options.recipeMode \|\| /receta\|rx\|rp/.test \|\| /^(dr\|dra)/.test`; activa modo laxo: omite consultationGate, threshold 0.96 |
| `strictConsultationMode` | Caller: consultationIsMedicine path | `consultationMode = true` en `searchMedicinesByName`; activa consultationGate filter |
| `preExtractedMedicines` | OCR block o extractMedicineRequests | Medicines pre-extraídas para evitar re-extracción;van directo a `dedupeStrings` → candidateMedicines |
| `queryDosageSignatures` | Single-medicine path (línea 3233) | Pasa las dosages del texto original ("32mg") a `searchMedicinesByName` para dosage penalty |
| `forceExactConsultationToken` | consultationMode path (línea 3093) | Activa matching exacto en token set |
