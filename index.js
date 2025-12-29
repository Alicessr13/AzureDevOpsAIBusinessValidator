const azureDevOps = require('azure-devops-node-api');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const readline = require('readline');
require('dotenv').config();

// Configurações
const ORG_URL = process.env.ORG_URL;
const ADO_PAT = process.env.ADO_PAT;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const FIELD_UPDATE_ANALYSIS = process.env.FIELD_UPDATE_ANALYSIS;

const askQuestion = (query) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(query, ans => { rl.close(); resolve(ans); }));
};

async function streamToString(readableStream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        readableStream.on("data", (data) => chunks.push(data instanceof Buffer ? data : Buffer.from(data)));
        readableStream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        readableStream.on("error", reject);
    });
}

// Função para analisar
async function analisarPR(gitApi, prId, requirementsText) {
    console.log(`\n--- Iniciando análise do PR #${prId} ---`);
    
    try {
        const prDetails = await gitApi.getPullRequestById(prId);
        
        if (!prDetails) {
            console.log(`   Erro: API retornou null para PR #${prId}.`);
            return `<p style="color:red">Erro: PR #${prId} não encontrado/inacessível.</p>`;
        }

        const repoId = prDetails.repository.id;
        const projectName = prDetails.repository.project.name;
        const prTitle = prDetails.title;

        console.log(`   Título: ${prTitle}`);
        console.log("   Baixando arquivos...");

        const diffs = await gitApi.getPullRequestIterations(repoId, prId);
        if (!diffs || diffs.length === 0) {
            return `<h3>PR #${prId}: ${prTitle}</h3><p><em>Nenhuma iteração encontrada.</em></p><hr>`;
        }

        const lastIterationId = diffs[diffs.length - 1].id;
        const changes = await gitApi.getPullRequestIterationChanges(repoId, prId, lastIterationId);

        let codeContext = "";

        if (changes && changes.changeEntries) {
            for (const entry of changes.changeEntries) {
                const itemData = entry.item;
                const changeType = entry.changeType;

                if (!itemData || changeType === 16 || itemData.isFolder) continue;

                const path = itemData.path;
                const objectId = itemData.objectId;

                try {
                    const blobStream = await gitApi.getBlobContent(repoId, objectId, projectName, true);
                    const contentText = await streamToString(blobStream);

                    if (contentText.indexOf('\0') !== -1) {
                        console.log(`   Binário ignorado: ${path}`);
                        continue; 
                    }

                    codeContext += `\n--- ARQUIVO: ${path} ---\n`;
                    codeContext += contentText + "\n";
                    console.log(`   Lido: ${path}`);

                } catch (err) {
                    console.log(`   Erro ao ler ${path}: ${err.message}`);
                }
            }
        }

        if (!codeContext) {
            return `<h3>PR #${prId}: ${prTitle}</h3><p><em>Nenhum código legível.</em></p><hr>`;
        }

        console.log(`   Enviando para o Gemini...`);

        const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        const prompt = `
        Você é um Tech Lead. Analise este PR.
        CONTEXTO DO CARD: ${requirementsText}
        CÓDIGO DESTE PR: ${codeContext}
        
        INSTRUÇÕES:
        1. Verifique se o código atende à DESCRIÇÃO e CRITÉRIOS DE ACEITE.
        2. Ignore estilo, foque na REGRA DE NEGÓCIO.
        3. Ignore questões técnicas que não impactam a regra de negócio.
        4. Indique se faltar algo mas que possa estar em outro PR.
        5. Diga se foi APROVADO ou REPROVADO.
        6. Se estiver tudo certo, responda com o motivo da aprovação.
        7. Se faltar algo, liste objetivamente.
        `;

        const result = await model.generateContent(prompt);
        const analise = result.response.text();
        
        return `
        <div style="margin-bottom: 20px; border-bottom: 1px solid #ccc; padding-bottom: 10px;">
            <h3>Análise PR #${prId}: ${prTitle}</h3>
            ${analise.replace(/\n/g, '<br>')}
        </div>
        `;

    } catch (error) {
        console.log(`   Falha interna: ${error.message}`);
        return `<p style="color:red">Erro ao analisar PR #${prId}: ${error.message}</p>`;
    }
}

async function main() {
    console.log("Iniciando script de análise...");

    if (!ADO_PAT || !GOOGLE_API_KEY) process.exit(1);

    try {
        const authHandler = azureDevOps.getPersonalAccessTokenHandler(ADO_PAT);
        const connection = new azureDevOps.WebApi(ORG_URL, authHandler);
        const gitApi = await connection.getGitApi();
        const workItemApi = await connection.getWorkItemTrackingApi();

        console.log("Escolha o modo de operação:");
        console.log("1 - Analisar um Pull Request específico");
        console.log("2 - Analisar um Card (e todos os PRs vinculados)");
        
        const modeInput = await askQuestion("-> Digite 1 ou 2: ");
        const idInput = await askQuestion("-> Digite o ID: ");
        const ID = parseInt(idInput.trim());

        if (!ID) { console.error("ID inválido."); process.exit(1); }

        let wiId = null;
        let prsParaAnalisar = new Set();

        if (modeInput.trim() === '1') {
            // MODO PR
            console.log(`\nBuscando Card vinculado ao PR ${ID}...`);
            const pr = await gitApi.getPullRequestById(ID);
            const workItemRefs = await gitApi.getPullRequestWorkItemRefs(pr.repository.id, ID);

            if (!workItemRefs || workItemRefs.length === 0) {
                console.error("Nenhum Card vinculado a este PR.");
                return;
            }
            wiId = parseInt(workItemRefs[0].url.split('/').pop());
            prsParaAnalisar.add(ID);

        } else {
            // MODO CARD
            console.log(`\nBuscando PRs vinculados ao Card ${ID}...`);
            wiId = ID;
            
            const workItemCheck = await workItemApi.getWorkItem(wiId, null, null, 1);
            
            if (workItemCheck.relations) {
                console.log(`Analisando ${workItemCheck.relations.length} relações...`);
                
                workItemCheck.relations.forEach(rel => {
                    const url = rel.url ? rel.url.toLowerCase() : '';
                    
                    if (url.includes('pullrequestid')) {

                        const decodedUrl = decodeURIComponent(rel.url);

                        const match = decodedUrl.match(/\/(\d+)$/);
                        
                        if (match && match[1]) {
                            const foundId = parseInt(match[1]);
                            console.log(`Identificado PR #${foundId}`);
                            prsParaAnalisar.add(foundId);
                        } else {
                            const parts = decodedUrl.split('/');
                            const lastPart = parts[parts.length - 1];
                            if (!isNaN(parseInt(lastPart))) {
                                prsParaAnalisar.add(parseInt(lastPart));
                            }
                        }
                    }
                });
            }

            if (prsParaAnalisar.size === 0) {
                console.error("Nenhum PR encontrado. Verifique se os links no card são realmente Pull Requests.");
                return;
            }
        }

        console.log(`\nObtendo requisitos do Card ${wiId}...`);
        const workItem = await workItemApi.getWorkItem(wiId);
        const title = workItem.fields['System.Title'];
        const description = workItem.fields['System.Description'] || '';
        const acceptanceCriteria = workItem.fields['Microsoft.VSTS.Common.AcceptanceCriteria'] || '';

        const requirementsText = `TÍTULO: ${title}\nDESCRIÇÃO: ${description}\nCRITÉRIOS: ${acceptanceCriteria}`;

        let relatorioFinal = `<h2>Relatório Gemini AI (${modeInput.trim() === '1' ? 'PR Único' : 'Completo'})</h2><p>Data: ${new Date().toLocaleString()}</p><hr>`;

        const listaPrs = Array.from(prsParaAnalisar);

        for (const prId of listaPrs) {
            const analiseHTML = await analisarPR(gitApi, prId, requirementsText);
            relatorioFinal += analiseHTML;
        }

        console.log("\nAtualizando o Card com a análise...");
        
        const patchDocument = [
            {
                "op": "add",
                "path": "/fields/" + FIELD_UPDATE_ANALYSIS,
                "value": relatorioFinal
            }
        ];

        await workItemApi.updateWorkItem(null, patchDocument, wiId);
        console.log(`Sucesso! Card ${wiId} atualizado.`);
    } catch (error) {
        console.error("Erro fatal:", error);
    }
}

main();