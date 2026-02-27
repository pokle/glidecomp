import type { ExternalPluginConfig } from '@windy/interfaces';

const config: ExternalPluginConfig = {
    name: 'windy-plugin-taskscore',
    version: '0.1.0',
    icon: '🪂',
    title: 'TaskScore Flight Analysis',
    description:
        'Analyze hanggliding and paragliding competition flights with thermal, glide, and sink analysis.',
    author: 'TaskScore',
    repository: 'https://github.com/AirScore/taskscore',
    desktopUI: 'rhpane',
    mobileUI: 'fullscreen',
    desktopWidth: 420,
    routerPath: '/taskscore',
    private: true,
};

export default config;
