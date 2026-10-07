// Fontes de ofertas da Shopee por tópico. Cada fonte é uma categoria oficial
// da Shopee (productCatId) com um preço mínimo: buscar por categoria traz o
// produto em si, e o piso de preço deixa de fora capinha, cabo, peça e
// suporte, que dominavam as buscas por palavra-chave.
//
// nome  -> rótulo usado na rotação (duas fontes com o mesmo nome contam como
//          a mesma categoria para não aparecerem em sequência)
// cat   -> productCatId da Shopee
// min   -> preço mínimo em reais
// exige / evita -> expressões aplicadas ao título sem acentos, em minúsculas
// oficial -> só aceita loja oficial da Shopee; usado onde há muito produto
//          falsificado (SSD de 16 TB por R$ 200, celular genérico etc.)

const MASCULINO = /\b(masculin[oa]s?|homem|homens|men)\b/;
const FEMININO = /\b(feminin[oa]s?|mulher(es)?|women)\b/;
const INFANTIL = /\b(infantil|infantis|bebe|juvenil|menin[oa]s?|kids)\b/;

export const FONTES = {
  eletronicos: [
    { nome: "smartphone", cat: 100073, min: 500, oficial: true },
    { nome: "tablet", cat: 100072, min: 350, oficial: true },
    { nome: "smartwatch", cat: 100270, min: 90, oficial: true },
    { nome: "monitor", cat: 101933, min: 350 },
    { nome: "notebook", cat: 101942, min: 1200, oficial: true },
    { nome: "computador", cat: 101944, min: 900, oficial: true },
    { nome: "teclado", cat: 101999, min: 70 },
    { nome: "mouse", cat: 101998, min: 50 },
    { nome: "armazenamento", cat: 101962, min: 120, oficial: true },
    { nome: "placa_video", cat: 101952, min: 700, oficial: true },
    { nome: "fone", cat: 100578, min: 60, oficial: true },
    { nome: "caixa_som", cat: 100625, min: 100 },
    { nome: "soundbar", cat: 100626, min: 150 },
    { nome: "tv", cat: 100185, min: 700, oficial: true },
    { nome: "projetor", cat: 100168, min: 150, oficial: true },
    { nome: "console", cat: 100695, min: 300, oficial: true },
    { nome: "jogos", cat: 100697, min: 80 },
    { nome: "air_fryer", cat: 100198, min: 180 },
    { nome: "liquidificador", cat: 100193, min: 80 },
    { nome: "cafeteira", cat: 100194, min: 100 },
    { nome: "microondas", cat: 100200, min: 300 },
    { nome: "robo_aspirador", cat: 100177, min: 150 },
    { nome: "ventilador", cat: 100181, min: 100 },
    { nome: "cadeira_gamer", cat: 101171, min: 300, exige: /\b(gamer|escritorio|ergonomica|presidente)\b/ },
    { nome: "camera_seguranca", cat: 101100, min: 80 },
    { nome: "roteador", cat: 101969, min: 60 },
  ],
  // Tópico principal (sem STATE_NAMESPACE): moda e cuidados masculinos.
  "": [
    { nome: "camiseta", cat: 100244, min: 30, evita: INFANTIL },
    { nome: "camisa", cat: 100243, min: 35, evita: INFANTIL },
    { nome: "camisa", cat: 100242, min: 40, evita: INFANTIL },
    { nome: "moletom", cat: 100226, min: 50, evita: INFANTIL },
    { nome: "casaco", cat: 100050, min: 60, evita: INFANTIL },
    { nome: "bermuda", cat: 100053, min: 35, evita: INFANTIL },
    { nome: "calca", cat: 100047, min: 50, evita: INFANTIL },
    { nome: "calca", cat: 100052, min: 50, evita: INFANTIL },
    { nome: "tenis", cat: 100064, min: 60, evita: INFANTIL },
    { nome: "sapato", cat: 100067, min: 70, evita: INFANTIL },
    { nome: "relogio", cat: 100574, min: 40, evita: FEMININO },
    { nome: "carteira", cat: 100571, min: 25 },
    { nome: "perfume", cat: 100661, min: 40, exige: MASCULINO },
    { nome: "mochila", cat: 100564, min: 50, evita: INFANTIL },
    { nome: "oculos", cat: 100151, min: 30, evita: INFANTIL },
    { nome: "barbeador", cat: 100877, min: 40 },
  ],
  feminino: [
    { nome: "vestido", cat: 100104, min: 35, evita: INFANTIL },
    { nome: "blusa", cat: 100099, min: 30, evita: INFANTIL },
    { nome: "calca", cat: 100103, min: 45, evita: INFANTIL },
    { nome: "legging", cat: 100100, min: 35, evita: INFANTIL },
    { nome: "conjunto", cat: 100378, min: 45, evita: INFANTIL },
    { nome: "lingerie", cat: 100111, min: 25, evita: INFANTIL },
    { nome: "bolsa", cat: 100095, min: 45 },
    { nome: "tenis", cat: 100557, min: 50, evita: INFANTIL },
    { nome: "sandalia", cat: 100561, min: 35, evita: INFANTIL },
    { nome: "salto", cat: 100559, min: 50, evita: INFANTIL },
    { nome: "perfume", cat: 100661, min: 35, evita: MASCULINO },
    { nome: "maquiagem", cat: 100662, min: 20 },
    { nome: "skincare", cat: 100664, min: 30 },
    { nome: "cabelo_eletrico", cat: 100889, min: 50 },
    { nome: "cabelo", cat: 100659, min: 30 },
    { nome: "acessorios", cat: 100022, min: 20 },
  ],
  mercado: [
    { nome: "suplementos", cat: 100005, min: 40 },
    { nome: "cafe_cha", cat: 100824, min: 25 },
    { nome: "chocolate", cat: 100646, min: 25 },
    { nome: "energetico", cat: 100827, min: 30 },
    { nome: "pasta_amendoim", cat: 100650, min: 20 },
    { nome: "sabao", cat: 101214, min: 30 },
    { nome: "desinfetante", cat: 101213, min: 25 },
    { nome: "higiene", cat: 102008, min: 20 },
    { nome: "cabelo", cat: 100871, min: 30 },
    { nome: "racao", cat: 100667, min: 40 },
    { nome: "fralda", cat: 101003, min: 40 },
  ],
};
