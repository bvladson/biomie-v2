"""BIOMIE Intelligence Engine: análises do Estoque fora das requisições da tela.

Lê os dados já consolidados no BIOMIE pelas funções protegidas (nunca chama o Omie), calcula os
indicadores de cada produto por empresa e grava tudo numa execução que só passa a valer quando
termina inteira. Consultivo: não altera saldos, curvas oficiais, preços nem documentos.
"""

VERSION = "intel-1.3.0"
