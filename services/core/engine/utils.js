import { log } from '../../../lib/logger.js';

// Utilidades compartidas para el voicebot

/** Normaliza un RUT: elimina puntos y espacios, deja K en mayúscula */
export function normalizeRut(rut) {
	if (!rut) return null;
	return rut.toString().replace(/\./g, '').replace(/\s+/g, '').replace(/-/g, '').toUpperCase();
}

/** Extrae patrón RUT desde un texto (busca grupos de dígitos y K si existe) */
export function extractRutFromText(text) {
	if (!text) return null;

	// Normalizar texto de voz a dígitos (ej: "un cuatro" -> "14")
	let normalizedText = textToDigits(text);

	// Eliminar todo lo que no sea dígito, 'K' o 'k' (excepto espacios temporales)
	// Pero mejor, limpiamos todo menos dígitos y K antes de aplicar un regex simplificado
	const digitsOnly = normalizedText.replace(/[^0-9Kk]/g, '').toUpperCase();

	// Buscar coincidencia de 7 a 9 caracteres (el RUT suele tener 8 o 9 con el DV)
	const m = digitsOnly.match(/\d{7,8}[0-9K]/);
	if (!m) return null;

	return m[0];
}

/** Formatea RUT limpio (12345678K) a formato visual (12.345.678-K) */
export function formatRut(rutClean) {
	if (!rutClean) return rutClean;
	const clean = rutClean.toString().replace(/[^0-9kK]/g, '').toUpperCase();
	if (clean.length < 2) return clean;

	const body = clean.slice(0, -1);
	const dv = clean.slice(-1);

	// Auto-format numbers with dots
	let formattedBody = body.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
	return `${formattedBody}-${dv}`;
}

/** 
 * Convierte palabras que representan números en español a dígitos.
 * Muy útil para transcripciones de voz donde los números a veces se deletrean o se agrupan.
 */
export function textToDigits(text) {
	if (!text) return "";
	let result = ` ${text.toLowerCase()} `; // Añadimos espacios para simplificar regex \b

	// Mapeo con orden de prioridad (las frases más largas primero)
	const replacements = [
		// Separadores y palabras de enlace (eliminar)
		{ phrase: ' millones ', digit: ' ' },
		{ phrase: ' millón ', digit: ' ' },
		{ phrase: ' millon ', digit: ' ' },
		{ phrase: ' mil ', digit: ' ' },
		{ phrase: ' y ', digit: ' ' },
		{ phrase: ' punto ', digit: ' ' },
		{ phrase: ' coma ', digit: ' ' },

		// Decenas con 'y' (mapear a primer dígito para concatenar)
		{ phrase: 'treinta y ', digit: '3' },
		{ phrase: 'cuarenta y ', digit: '4' },
		{ phrase: 'cincuenta y ', digit: '5' },
		{ phrase: 'sesenta y ', digit: '6' },
		{ phrase: 'setenta y ', digit: '7' },
		{ phrase: 'ochenta y ', digit: '8' },
		{ phrase: 'noventa y ', digit: '9' },

		// Centenas
		{ phrase: 'ciento ', digit: '1' },
		{ phrase: 'doscientos ', digit: '2' },
		{ phrase: 'trescientos ', digit: '3' },
		{ phrase: 'cuatrocientos ', digit: '4' },
		{ phrase: 'quinientos ', digit: '5' },
		{ phrase: 'seiscientos ', digit: '6' },
		{ phrase: 'setecientos ', digit: '7' },
		{ phrase: 'ochocientos ', digit: '8' },
		{ phrase: 'novecientos ', digit: '9' },

		// Especiales
		{ phrase: 'veinti', digit: '2' },
		{ phrase: 'diez ', digit: '10 ' },
		{ phrase: 'once ', digit: '11 ' },
		{ phrase: 'doce ', digit: '12 ' },
		{ phrase: 'trece ', digit: '13 ' },
		{ phrase: 'catorce ', digit: '14 ' },
		{ phrase: 'quince ', digit: '15 ' },
		{ phrase: 'diez y ', digit: '1' }, // diez y seis -> 16 por concatenación

		// Unidades y otros
		{ phrase: 'cero', digit: '0' },
		{ phrase: 'un ', digit: '1 ' },
		{ phrase: 'uno ', digit: '1 ' },
		{ phrase: 'dos ', digit: '2 ' },
		{ phrase: 'tres ', digit: '3 ' },
		{ phrase: 'cuatro ', digit: '4 ' },
		{ phrase: 'cinco ', digit: '5 ' },
		{ phrase: 'seis ', digit: '6 ' },
		{ phrase: 'siete ', digit: '7 ' },
		{ phrase: 'ocho ', digit: '8 ' },
		{ phrase: 'nueve ', digit: '9 ' },
		{ phrase: 'veinte ', digit: '20 ' },
		{ phrase: 'treinta ', digit: '30 ' },
		{ phrase: 'cuarenta ', digit: '40 ' },
		{ phrase: 'cincuenta ', digit: '50 ' },
		{ phrase: 'sesenta ', digit: '60 ' },
		{ phrase: 'setenta ', digit: '70 ' },
		{ phrase: 'ochenta ', digit: '80 ' },
		{ phrase: 'noventa ', digit: '90 ' },
		{ phrase: 'cien ', digit: '100 ' },

		// Caracteres RUT
		{ phrase: 'guion', digit: '-' },
		{ phrase: 'guión', digit: '-' },
		{ phrase: 'raya', digit: '-' },
		{ phrase: 'menos', digit: '-' },
		{ phrase: ' ka ', digit: 'K' }
	];

	replacements.forEach(r => {
		const regex = new RegExp(r.phrase, 'g');
		result = result.replace(regex, r.digit);
	});

	return result.trim();
}

/** Calcula dígito verificador y valida RUT chileno
 * Input: rut sin puntos ni guión (ej: 12345678K o 12345678)
 */
export function isValidRut(rutRaw) {
	try {
		if (!rutRaw) return false;
		const rut = rutRaw.toString().replace(/\./g, '').replace(/-/g, '').toUpperCase();
		let body = rut.slice(0, -1);
		let dv = rut.slice(-1);

		// Si no tiene dv (solo números) no lo consideramos válido
		if (!body || !dv) return false;

		let sum = 0;
		let multiplier = 2;
		for (let i = body.length - 1; i >= 0; i--) {
			sum += parseInt(body.charAt(i), 10) * multiplier;
			multiplier = multiplier === 7 ? 2 : multiplier + 1;
		}
		const mod = 11 - (sum % 11);
		let dvExpected = '';
		if (mod === 11) dvExpected = '0';
		else if (mod === 10) dvExpected = 'K';
		else dvExpected = String(mod);

		return dvExpected === dv;
	} catch (err) {
		log('error', `Error validando RUT: ${err.message}`);
		return false;
	}
}

/** Masking simple para RUT: muestra solo últimos 4 caracteres */
export function maskRut(rut) {
	if (!rut) return '';
	const s = rut.toString();
	if (s.length <= 4) return s;
	return '***' + s.slice(-4);
}

/**
 * 🧹 cleanAsrNoise - Elimina ruido común del ASR antes de parsear
 * 
 * Elimina palabras basura que el ASR agrega (DIA, NOCHE, BUENAS, etc.)
 * sin tocar números ni estructura de RUT
 */
export function cleanAsrNoise(text) {
	if (!text) return '';
	return text
		.toUpperCase()
		.replace(/\b(DIA|DÍA|NOCHE|BUENAS|HOLA|EH|MMM|ESTE|GRACIAS|Y\s+BUENAS|BUENAS\s+NOCHE|BUENAS\s+TARDES)\b/g, '')
		.replace(/[^0-9K.\-\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * 🎯 Normalización previa de texto RUT (OBLIGATORIA)
 * Normaliza expresiones chilenas antes de aplicar regex
 */
function normalizeRutSpeech(input) {
	if (!input) return '';
	return input
		.toLowerCase()
		.replace(/[\.,]/g, ' ')
		.replace(/guión|guion|raya|menos|coma/g, '-')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * 🗺️ Diccionario DV hablado → valor real
 */
const DV_MAP = {
	'cero': '0',
	'uno': '1',
	'dos': '2',
	'tres': '3',
	'cuatro': '4',
	'cinco': '5',
	'seis': '6',
	'siete': '7',
	'ocho': '8',
	'nueve': '9',
	'k': 'K',
	'ka': 'K'
};

/**
 * 🎯 extractRutHard - Regex fuerte para capturar RUT numérico (PRIMERA CAPA)
 * 
 * Esta es la CAPA 1 del pipeline: regex agresivo antes de NLP semántico.
 * Captura RUTs en formato numérico: 14-348-258-8, 14.348.258-8, 143482588, etc.
 * También captura variantes habladas: "raya ocho", "coma ocho", etc.
 * 
 * @param {string} transcript - Transcripción del ASR
 * @returns {string|null} - RUT limpio (ej: "143482588") o null si no matchea
 */
export function extractRutHard(transcript) {
	if (!transcript) return null;

	// Normalizar primero
	const normalized = normalizeRutSpeech(transcript);
	
	// REGEX PRINCIPAL: BODY + DV juntos (⭐ CLAVE)
	// Soporta: "14 348 258 - ocho", "14348258 - 8", "14.348.258, raya ocho"
	const fullMatch = normalized.match(/(\d{1,2}(?:\s?\d{3}){2})\s*-\s*(\d|k|cero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)/);
	if (fullMatch) {
		const body = fullMatch[1].replace(/\s/g, '');
		const dvRaw = fullMatch[2];
		const dv = DV_MAP[dvRaw] || dvRaw.toUpperCase();
		return `${body}${dv}`;
	}

	// Fallback: Solo números con separadores
	const cleaned = cleanAsrNoise(transcript);
	const m = cleaned.match(/(\d{1,2})[\s.,-]?(\d{3})[\s.,-]?(\d{3})[\s.,-]?([0-9K])/);
	if (m) {
		const body = `${m[1]}${m[2]}${m[3]}`;
		const dv = m[4].toUpperCase();
		return `${body}${dv}`;
	}

	return null;
}

export function calcularEdad(fechaNacimiento) {
	if (!fechaNacimiento) return null;
	const n = new Date(fechaNacimiento);
	if (isNaN(n)) return null;
	const diff = Date.now() - n.getTime();
	const ageDt = new Date(diff);
	return Math.abs(ageDt.getUTCFullYear() - 1970);
}

/**
 * 🔧 parseRutFromSpeech - Parser determinístico para RUT hablado (Chile)
 * 
 * Maneja correctamente:
 * - "millones" como multiplicador 1.000.000
 * - "mil" como multiplicador 1.000
 * - "guión ocho" / "guión k" para DV
 * - Números hablados en español
 * 
 * @param {string} transcript - Transcripción del audio
 * @returns {object} { ok: boolean, body: number|null, dv: string|null, rut: string|null, reason: string }
 */
export function parseRutFromSpeech(transcript) {
	if (!transcript) {
		return { ok: false, body: null, dv: null, rut: null, reason: 'empty' };
	}

	// 🎯 REGEX PRINCIPAL: BODY + DV juntos (⭐ CLAVE - PRIMERA PRIORIDAD)
	// Normalizar primero para capturar "raya ocho", "coma ocho", etc.
	const normalized = normalizeRutSpeech(transcript);
	const fullMatch = normalized.match(/(\d{1,2}(?:\s?\d{3}){2})\s*-\s*(\d|k|cero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)/);
	if (fullMatch) {
		const body = parseInt(fullMatch[1].replace(/\s/g, ''), 10);
		const dvRaw = fullMatch[2];
		const dv = DV_MAP[dvRaw] || dvRaw.toUpperCase();
		const rutClean = normalizeRut(`${body}${dv}`);
		const valid = isValidRut(rutClean);
		
		return {
			ok: valid,
			body,
			dv,
			rut: valid ? rutClean : null,
			reason: valid ? 'ok' : 'dv_mismatch'
		};
	}

	// Normalizar texto - IMPORTANTE: normalizar "raya", "coma" a "guion" para consistencia
	const text = transcript
		.toLowerCase()
		.replace(/[.,;:()]/g, ' ')
		.replace(/guión|guion|raya|menos|coma(?=\s*(?:ocho|nueve|k|ka|\d))/g, ' guion ')
		.replace(/\s+/g, ' ')
		.trim();

	const tokens = text.split(' ').filter(Boolean);

	// Mapeo de palabras a números
	const WORD_NUM = {
		"cero": 0, "un": 1, "uno": 1, "una": 1, "dos": 2, "tres": 3, "cuatro": 4,
		"cinco": 5, "seis": 6, "siete": 7, "ocho": 8, "nueve": 9,
		"diez": 10, "once": 11, "doce": 12, "trece": 13, "catorce": 14, "quince": 15,
		"dieciseis": 16, "dieciséis": 16, "diecisiete": 17, "dieciocho": 18, "diecinueve": 19,
		"veinte": 20, "veintiuno": 21, "veintiuna": 21, "veintidos": 22, "veintidós": 22,
		"veintitres": 23, "veintitrés": 23, "veinticuatro": 24, "veinticinco": 25,
		"veintiseis": 26, "veintiséis": 26, "veintisiete": 27, "veintiocho": 28, "veintinueve": 29,
		"treinta": 30, "cuarenta": 40, "cincuenta": 50, "sesenta": 60,
		"setenta": 70, "ochenta": 80, "noventa": 90,
		"cien": 100, "ciento": 100,
		"doscientos": 200, "trescientos": 300, "cuatrocientos": 400,
		"quinientos": 500, "seiscientos": 600, "setecientos": 700,
		"ochocientos": 800, "novecientos": 900,
		// DV letra
		"k": "K", "ka": "K"
	};

	// Palabras filler a ignorar
	const FILLER = new Set([
		"rut", "mi", "el", "es", "por", "favor", "porfa", "porfavor", "de", "del", "la",
		"numero", "número", "digito", "dígito", "verificador", "dv", "punto", "puntos", "coma", "comas"
	]);

	// 1️⃣ Extraer DV explícito (prioridad: "guion X" o "verificador X")
	let dv = null;
	let dvSource = null;
	for (let i = 0; i < tokens.length - 1; i++) {
		const w = tokens[i];
		
		// "guion ocho" / "guion k" / "guion 8"
		if (w === "guion") {
			const next = tokens[i + 1];
			if (/^\d$/.test(next)) {
				dv = next;
				dvSource = "guion";
				break;
			}
			if (WORD_NUM[next] === "K") {
				dv = "K";
				dvSource = "guion";
				break;
			}
			if (WORD_NUM[next] !== undefined && typeof WORD_NUM[next] === "number" && WORD_NUM[next] >= 0 && WORD_NUM[next] <= 9) {
				dv = String(WORD_NUM[next]);
				dvSource = "guion";
				break;
			}
		}
		
		// "verificador ocho" / "dv ocho"
		if ((w === "verificador" || w === "dv") && i + 1 < tokens.length) {
			const next = tokens[i + 1];
			if (/^\d$/.test(next)) {
				dv = next;
				dvSource = "dv";
				break;
			}
			if (WORD_NUM[next] === "K") {
				dv = "K";
				dvSource = "dv";
				break;
			}
			if (WORD_NUM[next] !== undefined && typeof WORD_NUM[next] === "number" && WORD_NUM[next] >= 0 && WORD_NUM[next] <= 9) {
				dv = String(WORD_NUM[next]);
				dvSource = "dv";
				break;
			}
		}
	}

	// 2️⃣ Separar tokens numéricos (todo antes de "guion" si existe)
	let numTokens = tokens.slice();
	const guionIdx = numTokens.indexOf("guion");
	if (guionIdx >= 0) {
		numTokens = numTokens.slice(0, guionIdx);
	}

	// Limpiar fillers
	numTokens = numTokens.filter(t => !FILLER.has(t));

	// 3️⃣ Detectar si hay RUT inline (ej: "14.348.258-8")
	const inlineMatch = transcript.match(/(\d{1,2})\s*\.?\s*(\d{3})\s*\.?\s*(\d{3})\s*[-]\s*([0-9kK])/);
	if (inlineMatch) {
		const body = parseInt(inlineMatch[1] + inlineMatch[2] + inlineMatch[3], 10);
		const dvInline = inlineMatch[4].toUpperCase();
		const rutClean = normalizeRut(`${body}${dvInline}`);
		const valid = isValidRut(rutClean);
		return {
			ok: valid,
			body,
			dv: dvInline,
			rut: valid ? rutClean : null,
			reason: valid ? 'ok' : 'dv_mismatch'
		};
	}

	// 4️⃣ Si hay muchos dígitos concatenables, usarlos directamente
	const joinedDigits = numTokens.filter(t => /^\d+$/.test(t)).join("");
	let bodyCandidate = null;
	let usedMillion = false;
	let usedThousand = false;

	if (joinedDigits.length >= 6) {
		bodyCandidate = parseInt(joinedDigits, 10);
	} else {
		// 5️⃣ Parsear estructura con millones/mil
		let millions = 0;
		let thousands = 0;
		let rest = 0;
		
		let buf = [];
		let foundMillion = false;
		let foundThousand = false;
		
		for (let i = 0; i < numTokens.length; i++) {
			const t = numTokens[i];
			
			if (t === "millones" || t === "millon") {
				// Si hay tokens antes de "millones", son el multiplicador
				if (buf.length > 0) {
					millions = parseGroup(buf, WORD_NUM);
				} else {
					// Si no hay tokens antes, asumimos 1 millón (forma abreviada)
					// El siguiente grupo va a miles, no a millones
					millions = 1;
				}
				buf = [];
				foundMillion = true;
				usedMillion = true;
				continue;
			}
			
			if (t === "mil") {
				// Si hay tokens antes de "mil", son el multiplicador de miles
				if (buf.length > 0) {
					thousands = parseGroup(buf, WORD_NUM) || 1;
				} else {
					thousands = 1;
				}
				buf = [];
				foundThousand = true;
				usedThousand = true;
				continue;
			}
			
			buf.push(t);
		}
		
		// El resto va al final
		rest = parseGroup(buf, WORD_NUM);
		
		// Si no encontramos "millones" pero el número es grande, podría ser que dijeron "catorce millones..."
		// En ese caso, el buf completo debería parsearse como millones + miles + resto
		if (!foundMillion && !foundThousand && buf.length > 0) {
			// Intentar parsear todo como un número compuesto
			const fullNumber = parseGroup(buf, WORD_NUM);
			if (fullNumber >= 1000000) {
				millions = Math.floor(fullNumber / 1000000);
				const remainder = fullNumber % 1000000;
				thousands = Math.floor(remainder / 1000);
				rest = remainder % 1000;
				usedMillion = true;
				usedThousand = thousands > 0;
			} else {
				rest = fullNumber;
			}
		}
		
		bodyCandidate = (millions * 1_000_000) + (thousands * 1_000) + rest;
	}

	// Helper para parsear un grupo de tokens a número
	function parseGroup(groupTokens, wordMap) {
		if (!groupTokens || groupTokens.length === 0) return 0;
		
		// Si viene un número directo
		if (groupTokens.length === 1 && /^\d+$/.test(groupTokens[0])) {
			return parseInt(groupTokens[0], 10);
		}
		
		// Si viene secuencia de dígitos sueltos "tres cuatro ocho" => 348
		let seq = "";
		for (const t of groupTokens) {
			if (/^\d$/.test(t)) {
				seq += t;
			} else if (wordMap[t] !== undefined && typeof wordMap[t] === "number" && wordMap[t] >= 0 && wordMap[t] <= 9) {
				seq += String(wordMap[t]);
			} else {
				break;
			}
		}
		if (seq.length >= 2) {
			return parseInt(seq, 10);
		}
		
		// Parse composicional
		let total = 0;
		for (const t of groupTokens) {
			if (t === "y") continue; // Ignorar conectores
			if (/^\d+$/.test(t)) {
				total += parseInt(t, 10);
			} else if (wordMap[t] !== undefined) {
				const v = wordMap[t];
				if (typeof v === "number") {
					total += v;
				}
			}
		}
		return total;
	}

	// 6️⃣ Validar body
	if (!bodyCandidate || isNaN(bodyCandidate) || bodyCandidate < 100000 || bodyCandidate > 99999999) {
		return {
			ok: false,
			body: null,
			dv: null,
			rut: null,
			reason: 'invalid_body'
		};
	}

	// 7️⃣ Si no hay DV explícito, intentar inferir del final
	if (!dv) {
		// Buscar último token numérico o k/ka
		for (let i = tokens.length - 1; i >= 0; i--) {
			const t = tokens[i];
			if (/^\d$/.test(t)) {
				dv = t;
				break;
			}
			if (t === "k" || t === "ka") {
				dv = "K";
				break;
			}
			if (WORD_NUM[t] !== undefined && typeof WORD_NUM[t] === "number" && WORD_NUM[t] >= 0 && WORD_NUM[t] <= 9) {
				dv = String(WORD_NUM[t]);
				break;
			}
			// Si topa un separador fuerte, corta
			if (t === "rut" || t === "verificador" || t === "guion") break;
		}
	}

	if (!dv) {
		return {
			ok: false,
			body: bodyCandidate,
			dv: null,
			rut: null,
			reason: 'missing_dv'
		};
	}

	dv = dv.toUpperCase();
	const rutClean = normalizeRut(`${bodyCandidate}${dv}`);
	const valid = isValidRut(rutClean);

	return {
		ok: valid,
		body: bodyCandidate,
		dv,
		rut: valid ? rutClean : null,
		reason: valid ? 'ok' : 'dv_mismatch',
		dvExpected: valid ? null : (() => {
			// Calcular DV esperado para ayudar en debugging
			let sum = 0;
			let multiplier = 2;
			const bodyStr = String(bodyCandidate);
			for (let i = bodyStr.length - 1; i >= 0; i--) {
				sum += parseInt(bodyStr.charAt(i), 10) * multiplier;
				multiplier = multiplier === 7 ? 2 : (multiplier + 1);
			}
			const mod = 11 - (sum % 11);
			if (mod === 11) return '0';
			if (mod === 10) return 'K';
			return String(mod);
		})()
	};
}

