import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import 'dotenv/config';

const commands = [
    new SlashCommandBuilder()
        .setName('workon')
        .setDescription('Cambia el repositorio activo en el que el agente está trabajando.')
        .addStringOption(option => 
            option.setName('repo')
                .setDescription('Nombre de la carpeta del repositorio')
                .setRequired(true)),
                
    new SlashCommandBuilder()
        .setName('status')
        .setDescription('Muestra en qué proyecto está trabajando el agente actualmente.'),

    new SlashCommandBuilder()
        .setName('policy')
        .setDescription('Configura la política autónoma del repo activo.')
        .addIntegerOption(option =>
            option.setName('hours')
                .setDescription('Máximo de horas por run autónomo (1-4)')
                .setMinValue(1)
                .setMaxValue(4)
                .setRequired(false))
        .addIntegerOption(option =>
            option.setName('commits')
                .setDescription('Máximo de commits por run autónomo')
                .setMinValue(1)
                .setMaxValue(50)
                .setRequired(false))
        .addIntegerOption(option =>
            option.setName('parallel')
                .setDescription('Máximo de tareas paralelas')
                .setMinValue(1)
                .setMaxValue(6)
                .setRequired(false))
        .addIntegerOption(option =>
            option.setName('retries')
                .setDescription('Máximo de reintentos por tarea')
                .setMinValue(0)
                .setMaxValue(5)
                .setRequired(false))
        .addIntegerOption(option =>
            option.setName('improvements')
                .setDescription('Ciclos máximos de self-improvement')
                .setMinValue(0)
                .setMaxValue(4)
                .setRequired(false))
        .addBooleanOption(option =>
            option.setName('autoapproveplan')
                .setDescription('Autoaprueba planes en modo nightly')
                .setRequired(false)),
        
    new SlashCommandBuilder()
        .setName('init')
        .setDescription('Crea la estructura base para un nuevo proyecto.')
        .addStringOption(option => 
            option.setName('type')
                .setDescription('El tipo de arquitectura')
                .setRequired(true)
                .addChoices(
                    { name: 'Expo (Frontend Mobile)', value: 'expo' },
                    { name: 'NestJS (Backend API)', value: 'nest' },
                    { name: 'Fullstack (Expo + Nest Monorepo)', value: 'fullstack' }
                ))
        .addStringOption(option => 
            option.setName('name')
                .setDescription('El nombre de tu nuevo proyecto (sin espacios)')
                .setRequired(true))
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN as string);

(async () => {
    try {
        console.log('🚀 Registrando Slash Commands en Discord...');
        await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID as string), { body: commands });
        console.log('✅ ¡Comandos registrados con éxito!');
    } catch (error) {
        console.error('❌ Error registrando comandos:', error);
    }
})();
