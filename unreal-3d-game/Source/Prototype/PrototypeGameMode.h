#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "PrototypeGameMode.generated.h"

/** Default game mode: spawns APrototypeCharacter as the player pawn. */
UCLASS()
class PROTOTYPE_API APrototypeGameMode : public AGameModeBase
{
	GENERATED_BODY()

public:
	APrototypeGameMode();
};
