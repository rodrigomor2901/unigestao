# Marca do UniGestão

## O que é

O U do Grupo Uniseter — três traços finos aninhados, degradê amarelo em cima e
laranja embaixo — com a **perna direita substituída por uma peça de encaixe em
navy**, já assentada, com a junta à mostra.

A leitura é a arquitetura do sistema: as frentes do Grupo continuam sendo cada
uma a sua, e a peça navy é o que fecha o conjunto. Navy porque é a cor da
palavra UNISETER no logotipo do Grupo — a cor da instituição.

## Cores

Tiradas do arquivo original da marca do Grupo, não escolhidas por semelhança.

| | |
|---|---|
| Amarelo | `#F7B312` |
| Laranja | `#EC7807` |
| Navy | `#26357A` |

O degradê do U é **vertical** (amarelo em cima, laranja embaixo), igual ao do
símbolo do Grupo. A linha de horizonte da marca original é que usa degradê
horizontal — não confundir.

## Arquivos

| Arquivo | Onde usar |
|---|---|
| `simbolo.svg` | fundo claro |
| `simbolo-claro.svg` | fundo navy ou escuro (a peça vira branca) |
| `lockup.svg` | símbolo + nome, fundo claro |
| `lockup-claro.svg` | símbolo + nome, fundo escuro |
| `favicon.svg` | ícone da aba (é o símbolo, com o nome que o navegador procura) |

Todos são SVG: pesam cerca de 2 KB, ficam nítidos em qualquer tela e podem ser
coloridos ou redimensionados sem perder qualidade.

## Limites que valem saber

**Abaixo de uns 24 px o encaixe some.** A peça, o dente e a folga desaparecem
juntos e sobra o U. Isso é do conceito, não da execução — encaixe é detalhe, e
detalhe não sobrevive a ícone de aba. Por isso a marca completa vai na tela de
login e na barra do topo, e o favicon assume que só o U vai ser lido.

**O nome nos lockups é texto, não contorno.** Mantém o arquivo pequeno e
editável, mas depende da fonte: sem DM Sans instalada, cai em Arial. Para
gráfica ou fornecedor externo, converter o texto em curvas antes de enviar.

**Nos e-mails a marca não entra.** O Outlook bloqueia imagem por padrão e um
aviso de acesso com logo quebrado parece golpe — lá o nome continua em texto.
Ver `core/email.js`.

**Isto ainda não passou por quem cuida da marca do Grupo.** O símbolo foi
derivado lendo o arquivo original, sem manual de marca. Se existir um, vale
conferir área de proteção, versão monocromática e o que pode ser derivado do
símbolo antes de tratar isto como oficial.
