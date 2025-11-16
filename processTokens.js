const fs = require('fs');

// Función para procesar un archivo de tokens
function processTokensFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
        return [];
    } catch (error) {
        console.error(`Error leyendo ${filePath}:`, error);
        return [];
    }
}

// Leer ambos archivos de tokens
const tokens1 = processTokensFile('tokens.json');
const tokens2 = processTokensFile('tokens2.json');

// Combinar los tokens
const allTokens = [...tokens1, ...tokens2];

// Procesar cada token y extraer solo los de eip155:5000
const tokenMap = {};
allTokens
    .filter(token => {
        // Verificar si el token tiene una dirección en eip155:5000
        return token.contractAddressByChain && 
               token.contractAddressByChain['eip155:5000'];
    })
    .forEach(token => {
        const mantleChainData = token.contractAddressByChain['eip155:5000'];
        tokenMap[mantleChainData.address.toLowerCase()] = token.id;
    });

// Generar el contenido del archivo en el formato deseado
const content = `const TOKEN_ID_MAP = ${JSON.stringify(tokenMap, null, 2).replace(/\n/g, '\n  ')};

`;

// Guardar el resultado en un nuevo archivo
fs.writeFileSync('token_id_map.js', content);

console.log('Archivo token_id_map.js generado exitosamente!');