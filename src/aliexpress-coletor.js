// Coleta "em alta no Brasil" do portal de afiliados do AliExpress (Ad Center).
// Roda no console (ou no javascript_tool) de uma aba logada em
// https://portals.aliexpress.com/affiportals/web/ad_center.htm, com
// "node src/aliexpress.mjs --receive-hot" escutando no PC.
// Acompanhe por window.__ali ({ feito, itens, erros }) e depois chame window.__aliEnviar().
(() => {
  const PAGINAS = 10;
  const estado = window.__ali = { feito: false, itens: 0, erros: [] };
  const itens = [];
  (async () => {
    // Primeiro os que têm cupom; depois os mais vendidos em geral.
    for (const cupom of ["y", ""]) {
      for (let pagina = 1; pagina <= PAGINAS; pagina++) {
        try {
          const url = `/material/productRecommend.do?requireCouponCode=${cupom}&freeShipping=&shipTo=BR&currency=BRL&language=pt&pageSize=20&pageNum=${pagina}&type=1`;
          const json = await (await fetch(url, { credentials: "include" })).json();
          for (const r of json.data?.results || []) {
            itens.push({
              id: r.itemId, titulo: r.itemTitle, img: r.itemMainPic, url: r.itemUrl,
              preco: r.itemDiscountMoneyMin?.amount, de: r.itemOriginMoneyMin?.amount,
              nota: r.commentScore, vendas: r.sales30Day, code: r.itemBestCode || null,
            });
          }
          if (json.data?.finish || !(json.data?.results || []).length) break;
        } catch (erro) { estado.erros.push(`cupom=${cupom} pagina=${pagina}: ${erro.message}`); }
        estado.itens = itens.length;
      }
    }
    estado.itens = itens.length;
    estado.feito = true;
  })();
  // O navegador barra fetch de um site para o PC, então o envio é por formulário.
  window.__aliEnviar = () => {
    const formulario = Object.assign(document.createElement("form"), { method: "POST", action: "http://127.0.0.1:8772/" });
    formulario.append(Object.assign(document.createElement("input"), { type: "hidden", name: "dados", value: JSON.stringify(itens) }));
    document.body.append(formulario);
    formulario.submit();
  };
  return "coleta iniciada";
})();
