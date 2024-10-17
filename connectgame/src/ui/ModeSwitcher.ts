import { CheckBox, RadioGroup } from '@pixi/ui';
import { Match3Mode } from '../match3/Match3Config';
import { sfx } from '../utils/audio';

import { i18n } from '../utils/i18n';
import { Graphics } from 'pixi.js';

type ItemConfig = { mode: Match3Mode; text: string };

/** List of switcher items */
const items: ItemConfig[] = [
    {
        mode: 'easy',
        text: i18n.easyMode,
    },
    {
        mode: 'normal',
        text: i18n.normalMode,
    },
    {
        mode: 'hard',
        text: i18n.hardMode,
    },
];

/**
 * Game mode switcher, used in Settings popup
 */
export class ModeSwitcher extends RadioGroup {
    constructor() {
        const bgColor = 0xcf4b00;
        const fillColor = 0xffd579;
        const width = 36;
        const height = 36;
        const padding = 4;
        const radius = 18;

        super({
            items: items.map(
                (i) =>
                    new CheckBox({
                        text: i.text,
                        style: {
                            checked: new Graphics()
                                .roundRect(0, 0, width, height, radius)
                                .fill({ color: bgColor })
                                .roundRect(
                                    padding,
                                    padding,
                                    width - padding * 2,
                                    height - padding * 2,
                                    radius - padding,
                                )
                                .fill({ color: fillColor }),
                            unchecked: new Graphics()
                                .roundRect(0, 0, width, height, radius)
                                .fill({ color: bgColor })
                                .roundRect(
                                    padding,
                                    padding,
                                    width - padding * 2,
                                    height - padding * 2,
                                    radius - padding,
                                ),

                            text: {
                                fontFamily: 'Arial Rounded MT Bold',
                                fontSize: 20,
                                fill: 0xffffff,
                            },
                        },
                    }),
            ),
            type: 'vertical',
            elementsMargin: 10,
            selectedItem: 0,
        });

        this.addChild(this.innerView);
        this.onChange.connect(() => {
            sfx.play('common/sfx-press.wav');
        });
    }

    /** Set the currently selected game mode */
    public getSelectedMode() {
        return items[this.selected].mode;
    }

    /** Set the currently selected option by game mode */
    public setSelectedMode(mode: Match3Mode) {
        const index = items.findIndex((i) => i.mode === mode);
        if (index >= 0) this.selectItem(index);
    }

    /**
     * Override the original method to ensure that 'selected' will be set before
     * firing 'onChange' signal
     */
    public override selectItem(id: number) {
        this['items'].forEach((item: CheckBox, key: number) => {
            item.forceCheck(key === id);
        });
        this.value = this['options'].items[id].text;
        const changed = this.selected !== id;
        this.selected = id;
        if (changed) this.onChange.emit(id, this.value);
    }
}
